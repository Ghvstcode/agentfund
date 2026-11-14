package cli

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ghvstcode/agentfund/worker/internal/api"
	"github.com/ghvstcode/agentfund/worker/internal/config"
	"github.com/ghvstcode/agentfund/worker/internal/pipeline"
	"github.com/ghvstcode/agentfund/worker/internal/policy"
	"github.com/ghvstcode/agentfund/worker/internal/tokfmt"
)

type capSource struct {
	name  string
	value int64
}

// binding returns the smallest positive cap and its source ("" when none applies).
func binding(sources []capSource) (int64, string) {
	var best capSource
	for _, s := range sources {
		if s.value > 0 && (best.value == 0 || s.value < best.value) {
			best = s
		}
	}
	return best.value, best.name
}

func capLine(label string, sources []capSource) string {
	var parts []string
	for _, s := range sources {
		v := "none"
		if s.value > 0 {
			v = tokfmt.Format(s.value)
		}
		parts = append(parts, s.name+" "+v)
	}
	val, who := binding(sources)
	if val == 0 {
		return fmt.Sprintf("  %-22s no cap (%s)\n", label, strings.Join(parts, "; "))
	}
	return fmt.Sprintf("  %-22s %s — %s binds (%s)\n", label, tokfmt.Format(val), who, strings.Join(parts, "; "))
}

// capsSummary shows the server-published trust tier and caps next to the
// donor's own, and says which one binds. The server can only tighten.
func capsSummary(cfg *config.Config, p *config.Project, proj *api.Project, sizes map[string]int64) string {
	lim, pl, _, err := pipeline.EffectiveLimits(cfg, p)
	if err != nil {
		return "\nCaps: " + err.Error() + "\n"
	}
	deref := func(v *int64) int64 {
		if v == nil || *v < 0 {
			return 0
		}
		return *v
	}
	isNew := proj.Trust.Tier != policy.TierEstablished
	var b strings.Builder
	fmt.Fprintf(&b, "\nTrust and caps\n  server trust tier:     %q (%d merged task(s))", proj.Trust.Tier, proj.Trust.MergedTasks)
	if isNew {
		b.WriteString(" — treated as a NEW project: your new-project ceiling applies\n")
	} else {
		b.WriteString("\n")
	}
	task := []capSource{{"your max_tokens_per_task", lim.MaxTokensPerTask}, {"your project override", deref(pl.MaxTokensPerTask)}}
	if isNew {
		task = append(task, capSource{"your new_project_max_tokens_per_task", lim.NewProjectMaxTokensPerTask})
	}
	task = append(task, capSource{"server max_tokens_per_task", deref(proj.Trust.MaxTokensPerTask)})
	b.WriteString(capLine("per-task ceiling:", task))
	b.WriteString(capLine("per-day for project:", []capSource{
		{"your tokens_per_day (all projects)", lim.TokensPerDay}, {"your project override", deref(pl.TokensPerDay)},
		{"server max_tokens_per_day", deref(proj.Trust.MaxTokensPerDay)},
	}))
	b.WriteString(capLine("per-week for project:", []capSource{
		{"your tokens_per_week (all projects)", lim.TokensPerWeek}, {"your project override", deref(pl.TokensPerWeek)},
	}))
	b.WriteString("  Server-published caps can only tighten your policy, never loosen it.\n")
	ceiling, _ := binding(task)
	var over []string
	for id, n := range sizes {
		if ceiling > 0 && n > ceiling {
			over = append(over, fmt.Sprintf("%s (max_tokens %s)", id, tokfmt.Format(n)))
		}
	}
	sort.Strings(over)
	if len(over) > 0 {
		fmt.Fprintf(&b, "  Will NOT run under the per-task ceiling: %s\n", strings.Join(over, ", "))
	}
	return b.String()
}
