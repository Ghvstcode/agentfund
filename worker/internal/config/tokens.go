package config

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Tokens is a token quantity that reads "200m", "5M", "750k", "1.5m" or a plain integer.
type Tokens int64

// ParseTokens parses a budget string. Suffixes (case-insensitive): k = 1e3,
// m = 1e6, g or b = 1e9. Underscores and commas are ignored.
func ParseTokens(s string) (Tokens, error) {
	orig := s
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("_", "", ",", "").Replace(s)
	if s == "" {
		return 0, fmt.Errorf("empty token amount")
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'k':
		mult, s = 1e3, s[:len(s)-1]
	case 'm':
		mult, s = 1e6, s[:len(s)-1]
	case 'g', 'b':
		mult, s = 1e9, s[:len(s)-1]
	}
	if mult == 1 {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("invalid token amount %q (use e.g. 200m, 5M, 750k or an integer)", orig)
		}
		return Tokens(n), nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 0 || math.IsNaN(f) || f*mult > math.MaxInt64/2 {
		return 0, fmt.Errorf("invalid token amount %q (use e.g. 200m, 5M, 750k or an integer)", orig)
	}
	return Tokens(math.Round(f * mult)), nil
}

// String renders the amount compactly.
func (t Tokens) String() string {
	n := int64(t)
	switch {
	case n >= 1e9 && n%1e8 == 0:
		return trimFloat(float64(n)/1e9) + "g"
	case n >= 1e6 && n%1e5 == 0:
		return trimFloat(float64(n)/1e6) + "m"
	case n >= 1e3 && n%1e2 == 0:
		return trimFloat(float64(n)/1e3) + "k"
	}
	return strconv.FormatInt(n, 10)
}

func trimFloat(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// UnmarshalYAML accepts integers and suffixed strings.
func (t *Tokens) UnmarshalYAML(n *yaml.Node) error {
	v, err := ParseTokens(n.Value)
	if err != nil {
		return fmt.Errorf("line %d: %w", n.Line, err)
	}
	*t = v
	return nil
}

// MarshalYAML writes the compact form.
func (t Tokens) MarshalYAML() (any, error) { return t.String(), nil }
