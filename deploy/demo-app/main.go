// Command demoapp is a stand-in workload used to exercise distviz end to
// end: it serves a trivial HTTP endpoint and burns CPU/memory in bursts so
// the dashboard has something visibly changing to display.
package main

import (
	"log"
	"math/rand"
	"net/http"
	"time"
)

func main() {
	go burnResources()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})

	log.Println("demoapp listening on :9000")
	log.Fatal(http.ListenAndServe(":9000", nil))
}

// burnResources periodically spends CPU and holds onto memory for a random
// duration so container.cpu.usage and container.memory.usage move around.
func burnResources() {
	var ballast [][]byte
	for {
		busyFor := time.Duration(rand.Intn(2000)) * time.Millisecond
		deadline := time.Now().Add(busyFor)
		for time.Now().Before(deadline) {
			_ = sha256Like()
		}

		if rand.Intn(3) == 0 {
			ballast = append(ballast, make([]byte, 8*1024*1024)) // +8MB
		} else if len(ballast) > 0 {
			ballast = ballast[:len(ballast)-1]
		}

		time.Sleep(time.Duration(rand.Intn(1500)) * time.Millisecond)
	}
}

func sha256Like() uint64 {
	var x uint64 = 0xcbf29ce484222325
	for i := 0; i < 1_000_000; i++ {
		x ^= uint64(i)
		x *= 0x100000001b3
	}
	return x
}
