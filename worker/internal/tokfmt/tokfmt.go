// Package tokfmt is the one place token quantities are formatted for people:
// Exact for measured counts (tokens used: 8,250), Format for configured
// amounts such as caps and max_tokens (10M, 750k; exact when not round).
package tokfmt

import (
	"strconv"
	"strings"
)

// Format renders a token count: round amounts compactly with a unit
// (10M, 1.5M, 750k, 2G), everything else exactly with thousands separators
// (8,250). Both forms are accepted back by config.ParseTokens.
func Format(n int64) string {
	if c := Compact(n); c != "" {
		return c
	}
	return Exact(n)
}

// Compact returns the unit form for round amounts, or "" when n has none.
func Compact(n int64) string {
	switch {
	case n >= 1e9 && n%1e7 == 0:
		return trim(float64(n)/1e9) + "G"
	case n >= 1e6 && n < 1e9 && n%1e4 == 0:
		return trim(float64(n)/1e6) + "M"
	case n >= 1e3 && n < 1e6 && n%1e2 == 0:
		return trim(float64(n)/1e3) + "k"
	}
	return ""
}

// Exact renders n with thousands separators.
func Exact(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func trim(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
