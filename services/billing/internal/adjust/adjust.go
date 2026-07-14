package adjust

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/videopoint"
)

var ErrInsufficient = errors.New("余额不足")

type Service struct{ st *store.Store }

func New(st *store.Store) *Service { return &Service{st: st} }

// Adjust 管理员调余额：正=发永久桶；负=跨桶扣（不足拒绝）。幂等+流水(前后=Σ桶)。
func (s *Service) Adjust(opID, userID string, delta int64, reason, adminID string) (before int64, after int64, err error) {
	err = s.st.DB.Transaction(func(tx *gorm.DB) error {
		var existing model.BalanceAdjustment
		if e := tx.First(&existing, "operation_id = ?", opID).Error; e == nil {
			before, after = existing.BalanceBefore, existing.BalanceAfter
			return nil
		} else if !errors.Is(e, gorm.ErrRecordNotFound) {
			return e
		}

		b, e := bucket.Balance(tx, userID)
		if e != nil {
			return e
		}
		before = b

		if delta >= 0 {
			if e := bucket.GrantPoints(tx, userID, delta, nil, "adjust"); e != nil {
				return e
			}
		} else {
			_, ce := bucket.ConsumeInTx(tx, userID, -delta)
			if errors.Is(ce, bucket.ErrInsufficient) {
				return ErrInsufficient
			}
			if ce != nil {
				return ce
			}
		}
		after = before + delta

		return tx.Create(&model.BalanceAdjustment{
			OperationID: opID, UserID: userID, Delta: delta, Reason: reason,
			AdminID: adminID, AccountType: "points", BalanceBefore: before, BalanceAfter: after, CreatedAt: time.Now(),
		}).Error
	})
	return before, after, err
}

// AdjustVideo 管理员调视频点余额：正=充值；负=扣减（不足拒绝）。幂等+流水。
func (s *Service) AdjustVideo(opID, userID string, delta int64, reason, adminID string) (before int64, after int64, err error) {
	err = s.st.DB.Transaction(func(tx *gorm.DB) error {
		var existing model.BalanceAdjustment
		if e := tx.First(&existing, "operation_id = ?", opID).Error; e == nil {
			before, after = existing.BalanceBefore, existing.BalanceAfter
			return nil
		} else if !errors.Is(e, gorm.ErrRecordNotFound) {
			return e
		}

		b, e := videopoint.Balance(tx, userID)
		if e != nil {
			return e
		}
		before = b

		if delta >= 0 {
			if e := videopoint.CreditInTx(tx, userID, delta); e != nil {
				return e
			}
		} else {
			de := videopoint.DeductInTx(tx, userID, -delta)
			if errors.Is(de, videopoint.ErrInsufficient) {
				return ErrInsufficient
			}
			if de != nil {
				return de
			}
		}
		after = before + delta

		return tx.Create(&model.BalanceAdjustment{
			OperationID: opID, UserID: userID, Delta: delta, Reason: reason,
			AdminID: adminID, AccountType: "video", BalanceBefore: before, BalanceAfter: after, CreatedAt: time.Now(),
		}).Error
	})
	return before, after, err
}
