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

type Store struct {
	mu         sync.RWMutex
	components map[string]*Component
}

func New() *Store {
	return &Store{components: make(map[string]*Component)}
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

func cloneComponent(c *Component) Component {
	metrics := make(map[string]MetricPoint, len(c.Metrics))
	for k, v := range c.Metrics {
		metrics[k] = v
	}
	return Component{ID: c.ID, Name: c.Name, Type: c.Type, Metrics: metrics}
}
