// Package hub fans out live updates to connected WebSocket clients.
package hub

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	// MVP dashboard is same-origin; relax if the frontend moves to its own host.
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]chan []byte
}

func New() *Hub {
	return &Hub{clients: make(map[*websocket.Conn]chan []byte)}
}

// Broadcast sends a pre-encoded JSON message to every connected client.
func (h *Hub) Broadcast(message []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, send := range h.clients {
		select {
		case send <- message:
		default:
			// slow client, drop the message rather than block ingest
		}
	}
}

// ServeWS upgrades the connection and streams broadcast messages to it until
// the client disconnects. onConnect is called once, synchronously, to build
// an initial snapshot message to send before any live updates.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request, onConnect func() []byte) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	send := make(chan []byte, 16)
	h.mu.Lock()
	h.clients[conn] = send
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.clients, conn)
		h.mu.Unlock()
		conn.Close()
	}()

	if snapshot := onConnect(); snapshot != nil {
		if err := conn.WriteMessage(websocket.TextMessage, snapshot); err != nil {
			return
		}
	}

	// Drain client->server messages so pongs are handled and disconnects are
	// detected; the dashboard doesn't send anything meaningful itself.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				conn.Close()
				return
			}
		}
	}()

	for msg := range send {
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}
