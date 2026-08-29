// Package state holds the latest known snapshot of every component in
// memory, so live clients can be served instantly without hitting SQLite.
package state

import "sync"

type MetricPoint struct {
	Value      float64 `json:"value"`
	Unit       string  `json:"unit"`
	TsUnixNano int64   `json:"ts"`
}

type Component struct {
	ID      string                 `json:"id"`
	Name    string                 `json:"name"`
	Type    string                 `json:"type"`
	Metrics map[string]MetricPoint `json:"metrics"`
}

// Edge represents an observed dependency between two components: source
// called destination at least once. It's a sampled signal (see
// sdk/edgeclient), not a full call trace - Count is how many times it's
// been re-confirmed, not a real call count.
type Edge struct {
	Source       string `json:"source"`
	Destination  string `json:"destination"`
	LastSeenNano int64  `json:"lastSeen"`
	Count        int64  `json:"count"`
}

type Store struct {
	mu         sync.RWMutex
	components map[string]*Component
	edges      map[string]*Edge // keyed by "source\x00destination"
}

func New() *Store {
	return &Store{
		components: make(map[string]*Component),
		edges:      make(map[string]*Edge),
	}
}

// Apply merges a metric update into a component's live snapshot, creating
// the component if this is the first time it's been seen. Returns a copy of
// the updated component for broadcasting.
func (s *Store) Apply(id, name, typ, metricName string, point MetricPoint) Component {
	s.mu.Lock()
	defer s.mu.Unlock()

	c, ok := s.components[id]
	if !ok {
		c = &Component{ID: id, Name: name, Type: typ, Metrics: make(map[string]MetricPoint)}
		s.components[id] = c
	}
	c.Name = name
	if typ != "" {
		c.Type = typ
	}
	c.Metrics[metricName] = point

	return cloneComponent(c)
}

func (s *Store) Snapshot() []Component {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]Component, 0, len(s.components))
	for _, c := range s.components {
		out = append(out, cloneComponent(c))
	}
	return out
}

// RecordEdge marks source as having called destination, creating the edge
// if this is the first observation. Returns a copy for broadcasting.
func (s *Store) RecordEdge(source, destination string, ts int64) Edge {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := source + "\x00" + destination
	e, ok := s.edges[key]
	if !ok {
		e = &Edge{Source: source, Destination: destination}
		s.edges[key] = e
	}
	e.LastSeenNano = ts
	e.Count++
	return *e
}

// LoadEdges seeds live edge state from persisted storage (e.g. on backend
// startup), so a restart doesn't lose previously observed dependencies
// until every reporting component happens to re-confirm them on its own
// sampling schedule.
func (s *Store) LoadEdges(edges []Edge) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range edges {
		edge := e
		s.edges[e.Source+"\x00"+e.Destination] = &edge
	}
}

// LoadComponents seeds known components (without metrics, which fill in as
// fresh reports arrive) from persisted storage on startup, so components
// don't briefly disappear from the dashboard after a backend restart.
func (s *Store) LoadComponents(components []Component) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range components {
		if _, exists := s.components[c.ID]; exists {
			continue
		}
		s.components[c.ID] = &Component{ID: c.ID, Name: c.Name, Type: c.Type, Metrics: make(map[string]MetricPoint)}
	}
}

func (s *Store) EdgeSnapshot() []Edge {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]Edge, 0, len(s.edges))
	for _, e := range s.edges {
		out = append(out, *e)
	}
	return out
}

func cloneComponent(c *Component) Component {
	metrics := make(map[string]MetricPoint, len(c.Metrics))
	for k, v := range c.Metrics {
		metrics[k] = v
	}
	return Component{ID: c.ID, Name: c.Name, Type: c.Type, Metrics: metrics}
}
