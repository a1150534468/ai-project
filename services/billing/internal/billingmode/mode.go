package billingmode

import (
	"fmt"
	"strings"
)

type Mode string

const (
	Standard Mode = "standard"
	Learning Mode = "learning"
)

func Parse(raw string) (Mode, error) {
	switch Mode(strings.TrimSpace(raw)) {
	case "", Standard:
		return Standard, nil
	case Learning:
		return Learning, nil
	default:
		return "", fmt.Errorf("invalid BILLING_PRICING_MODE %q: want standard or learning", raw)
	}
}

func (m Mode) NormalizeCost(standardCost int64) int64 {
	if m == Learning {
		return 1
	}
	return standardCost
}
