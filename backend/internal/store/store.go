// Package store persists component metadata and metric history to an
// embedded, pure-Go SQLite database (no external services required).
package store

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS components (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL DEFAULT 'unknown',
	first_seen_unix_nano INTEGER NOT NULL,
	last_seen_unix_nano INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS datapoints (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	component_id TEXT NOT NULL,
	metric_name TEXT NOT NULL,
	value REAL NOT NULL,
	unit TEXT,
	ts_unix_nano INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_datapoints_lookup
	ON datapoints(component_id, metric_name, ts_unix_nano);

CREATE TABLE IF NOT EXISTS edges (
	source TEXT NOT NULL,
	destination TEXT NOT NULL,
	last_seen_unix_nano INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (source, destination)
);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// Pure-Go sqlite driver serializes writes; a single connection avoids
	// "database is locked" errors under concurrent ingest.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

type Component struct {
	ID            string
	Name          string
	Type          string
	FirstSeenNano int64
	LastSeenNano  int64
}

func (s *Store) UpsertComponent(c Component) error {
	_, err := s.db.Exec(`
		INSERT INTO components (id, name, type, first_seen_unix_nano, last_seen_unix_nano)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			type = excluded.type,
			last_seen_unix_nano = excluded.last_seen_unix_nano
	`, c.ID, c.Name, c.Type, c.FirstSeenNano, c.LastSeenNano)
	if err != nil {
		return fmt.Errorf("upsert component: %w", err)
	}
	return nil
}

func (s *Store) ListComponents() ([]Component, error) {
	rows, err := s.db.Query(`SELECT id, name, type, first_seen_unix_nano, last_seen_unix_nano FROM components`)
	if err != nil {
		return nil, fmt.Errorf("list components: %w", err)
	}
	defer rows.Close()

	var out []Component
	for rows.Next() {
		var c Component
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.FirstSeenNano, &c.LastSeenNano); err != nil {
			return nil, fmt.Errorf("scan component: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type Edge struct {
	Source       string
	Destination  string
	LastSeenNano int64
	Count        int64
}

func (s *Store) UpsertEdge(e Edge) error {
	_, err := s.db.Exec(`
		INSERT INTO edges (source, destination, last_seen_unix_nano, count)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(source, destination) DO UPDATE SET
			last_seen_unix_nano = excluded.last_seen_unix_nano,
			count = excluded.count
	`, e.Source, e.Destination, e.LastSeenNano, e.Count)
	if err != nil {
		return fmt.Errorf("upsert edge: %w", err)
	}
	return nil
}

func (s *Store) ListEdges() ([]Edge, error) {
	rows, err := s.db.Query(`SELECT source, destination, last_seen_unix_nano, count FROM edges`)
	if err != nil {
		return nil, fmt.Errorf("list edges: %w", err)
	}
	defer rows.Close()

	var out []Edge
	for rows.Next() {
		var e Edge
		if err := rows.Scan(&e.Source, &e.Destination, &e.LastSeenNano, &e.Count); err != nil {
			return nil, fmt.Errorf("scan edge: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type Datapoint struct {
	ComponentID string
	MetricName  string
	Value       float64
	Unit        string
	TsUnixNano  int64
}

func (s *Store) InsertDatapoint(d Datapoint) error {
	_, err := s.db.Exec(`
		INSERT INTO datapoints (component_id, metric_name, value, unit, ts_unix_nano)
		VALUES (?, ?, ?, ?, ?)
	`, d.ComponentID, d.MetricName, d.Value, d.Unit, d.TsUnixNano)
	if err != nil {
		return fmt.Errorf("insert datapoint: %w", err)
	}
	return nil
}

// History returns up to limit datapoints for a component/metric, most recent last.
func (s *Store) History(componentID, metricName string, limit int) ([]Datapoint, error) {
	rows, err := s.db.Query(`
		SELECT component_id, metric_name, value, unit, ts_unix_nano
		FROM datapoints
		WHERE component_id = ? AND metric_name = ?
		ORDER BY ts_unix_nano DESC
		LIMIT ?
	`, componentID, metricName, limit)
	if err != nil {
		return nil, fmt.Errorf("query history: %w", err)
	}
	defer rows.Close()

	var out []Datapoint
	for rows.Next() {
		var d Datapoint
		if err := rows.Scan(&d.ComponentID, &d.MetricName, &d.Value, &d.Unit, &d.TsUnixNano); err != nil {
			return nil, fmt.Errorf("scan datapoint: %w", err)
		}
		out = append(out, d)
	}
	// reverse to chronological order
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}
