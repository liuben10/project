// Package collector reads container resource usage from the Linux cgroup v2
// unified hierarchy. It works unmodified whether the agent runs as the
// container's PID 1, alongside the app process, or as a sidecar sharing the
// same cgroup/network namespace.
package collector

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Sample struct {
	CPUCores          float64 // cores consumed, averaged over the sampling interval
	CPUUtilization    float64 // fraction of the cgroup's CPU quota used; 0 if no quota is set
	HasCPUUtilization bool
	MemoryUsageBytes  float64
	MemoryLimitBytes  float64 // 0 if unlimited
}

type Collector struct {
	root string

	mu        sync.Mutex
	prevUsecs float64
	prevAt    time.Time
}

// New creates a collector reading from the given cgroup v2 root
// (typically "/sys/fs/cgroup").
func New(root string) *Collector {
	return &Collector{root: root}
}

func (c *Collector) Collect() (Sample, error) {
	usageUsec, err := c.readCPUUsageUsec()
	if err != nil {
		return Sample{}, fmt.Errorf("read cpu.stat: %w", err)
	}

	memCurrent, err := c.readIntFile("memory.current")
	if err != nil {
		return Sample{}, fmt.Errorf("read memory.current: %w", err)
	}

	memMax, err := c.readMemoryMax()
	if err != nil {
		return Sample{}, fmt.Errorf("read memory.max: %w", err)
	}

	quotaCores, hasQuota, err := c.readCPUQuotaCores()
	if err != nil {
		return Sample{}, fmt.Errorf("read cpu.max: %w", err)
	}

	c.mu.Lock()
	now := time.Now()
	var cpuCores float64
	if !c.prevAt.IsZero() {
		elapsedUsec := now.Sub(c.prevAt).Microseconds()
		if elapsedUsec > 0 {
			cpuCores = (usageUsec - c.prevUsecs) / float64(elapsedUsec)
		}
	}
	c.prevUsecs = usageUsec
	c.prevAt = now
	c.mu.Unlock()

	sample := Sample{
		CPUCores:         cpuCores,
		MemoryUsageBytes: memCurrent,
		MemoryLimitBytes: memMax,
	}
	if hasQuota && quotaCores > 0 {
		sample.CPUUtilization = cpuCores / quotaCores
		sample.HasCPUUtilization = true
	}
	return sample, nil
}

func (c *Collector) readCPUUsageUsec() (float64, error) {
	data, err := os.ReadFile(c.path("cpu.stat"))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "usage_usec" {
			return strconv.ParseFloat(fields[1], 64)
		}
	}
	return 0, fmt.Errorf("usage_usec not found in cpu.stat")
}

// readCPUQuotaCores returns the number of cores allotted by cpu.max
// ("<quota_usec> <period_usec>", or "max <period_usec>" if unlimited).
func (c *Collector) readCPUQuotaCores() (cores float64, ok bool, err error) {
	data, err := os.ReadFile(c.path("cpu.max"))
	if err != nil {
		return 0, false, err
	}
	fields := strings.Fields(string(data))
	if len(fields) != 2 || fields[0] == "max" {
		return 0, false, nil
	}
	quota, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, false, err
	}
	period, err := strconv.ParseFloat(fields[1], 64)
	if err != nil || period == 0 {
		return 0, false, err
	}
	return quota / period, true, nil
}

func (c *Collector) readMemoryMax() (float64, error) {
	data, err := os.ReadFile(c.path("memory.max"))
	if err != nil {
		return 0, err
	}
	s := strings.TrimSpace(string(data))
	if s == "max" {
		return 0, nil
	}
	return strconv.ParseFloat(s, 64)
}

func (c *Collector) readIntFile(name string) (float64, error) {
	data, err := os.ReadFile(c.path(name))
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
}

func (c *Collector) path(name string) string {
	return c.root + "/" + name
}
