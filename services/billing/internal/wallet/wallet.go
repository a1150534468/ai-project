package wallet

import (
	"errors"

	"ai-assistant-billing/internal/store"
)

var (
	ErrInsufficient = errors.New("余额不足")
	ErrNotReserved  = errors.New("预扣记录不存在")
)

type Wallet struct{ st *store.Store }

func New(st *store.Store) *Wallet { return &Wallet{st: st} }

type TokenUsage struct {
	InputTokens       int64
	OutputTokens      int64
	CacheInputTokens  int64
	CacheOutputTokens int64
}
