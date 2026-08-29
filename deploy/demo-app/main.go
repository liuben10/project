// Command demoapp is a stand-in workload used to exercise distviz end to
// end: it serves a trivial HTTP endpoint and burns CPU/memory in bursts so
// the dashboard has something visibly changing to display.
package main

import (
	"log"
	"math/rand"
	"net/http"
	"os"
	"time"

	"distviz/sdk/edgeclient"
)

func main() {
	go burnResources()

	if target := os.Getenv("CALL_TARGET"); target != "" {
		go callTargetLoop(target)
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})

	log.Println("demoapp listening on :9000")
	log.Fatal(http.ListenAndServe(":9000", nil))
}

// callTargetLoop periodically calls another system's HTTP endpoint through
// the edgeclient-wrapped client, so the resulting dependency shows up as an
// edge on the topology dashboard. This is purely to exercise/demo that
// feature - demoapp itself has no real reason to call anything.
func callTargetLoop(target string) {
	client := edgeclient.WrapClient(http.DefaultClient)
	for {
		resp, err := client.Get(target)
		if err != nil {
			log.Printf("call %s: %v", target, err)
		} else {
			resp.Body.Close()
		}
		time.Sleep(time.Duration(1000+rand.Intn(2000)) * time.Millisecond)
	}
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
