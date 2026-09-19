// Package tracecorrelate derives dependency edges from real distributed
// trace data: if a span's parent belongs to a different service.name, the
// parent's service depends on this span's service - the same idea Jaeger/
// Zipkin/Tempo use, just applied here to answer one question (does an edge
// exist) rather than rendering full traces. Correlation is exact (span ID
// equality via the standard W3C trace-context propagation OpenTelemetry's
// instrumentation already does), not fuzzy content or timing matching.
package tracecorrelate

import (
	"sync"
	"time"
)

// Window bounds how long a span is kept around waiting for its parent or
// children to show up - spans from two different containers can arrive in
// either order and aren't bundled into the same export.
const Window = 30 * time.Second

type Edge struct {
	Source      string
	Destination string
}

type spanRecord struct {
	service string
	seenAt  time.Time
}

type Tracker struct {
	mu              sync.Mutex
	spans           map[string]spanRecord // spanID -> record
	pendingByParent map[string][]string   // parentID -> child spanIDs seen before their parent
}

func New() *Tracker {
	return &Tracker{
		spans:           make(map[string]spanRecord),
		pendingByParent: make(map[string][]string),
	}
}

// Observe records a new span and returns any edges it confirms: one if its
// own parent was already known, plus one for each child that arrived
// earlier looking for this span as its parent.
func (t *Tracker) Observe(spanID, parentID, service string, at time.Time) []Edge {
	t.mu.Lock()
	defer t.mu.Unlock()

	var edges []Edge
	t.spans[spanID] = spanRecord{service: service, seenAt: at}

	if parentID != "" {
		if parent, ok := t.spans[parentID]; ok {
			if parent.service != service {
				edges = append(edges, Edge{Source: parent.service, Destination: service})
			}
		} else {
			t.pendingByParent[parentID] = append(t.pendingByParent[parentID], spanID)
		}
	}

	if children, ok := t.pendingByParent[spanID]; ok {
		for _, childID := range children {
			if child, ok := t.spans[childID]; ok && child.service != service {
				edges = append(edges, Edge{Source: service, Destination: child.service})
			}
		}
		delete(t.pendingByParent, spanID)
	}

	return edges
}

// Sweep drops spans and pending-child entries older than Window so memory
// doesn't grow unbounded. Call periodically.
func (t *Tracker) Sweep(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()

	for id, rec := range t.spans {
		if now.Sub(rec.seenAt) > Window {
			delete(t.spans, id)
		}
	}
	for parentID, children := range t.pendingByParent {
		fresh := children[:0]
		for _, childID := range children {
			if rec, ok := t.spans[childID]; ok && now.Sub(rec.seenAt) <= Window {
				fresh = append(fresh, childID)
			}
		}
		if len(fresh) == 0 {
			delete(t.pendingByParent, parentID)
		} else {
			t.pendingByParent[parentID] = fresh
		}
	}
}
