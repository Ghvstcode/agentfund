package pipeline

import (
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/store"
)

// usageWith returns current usage plus extra hypothetical reservations (dry-run).
func usageWith(st *store.State, w *Worker, extra int64) (g, p policy.Usage, active int) {
	g, p, active = store.UsageOf(st, w.now(), w.Ref.Key())
	g.Day += extra
	g.Week += extra
	p.Day += extra
	p.Week += extra
	return g, p, 0 // previewed tasks run one after another: concurrency is not what is being asked
}
