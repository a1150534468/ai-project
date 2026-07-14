package redeem

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/sub"
)

var (
	ErrInvalidCode      = errors.New("兑换码无效或已使用")
	ErrCodeExpired      = errors.New("兑换码已过期")
	ErrUnsupportedGrant = errors.New("暂不支持该类型兑换码")
)

type Service struct {
	st *store.Store
}

func New(st *store.Store) *Service { return &Service{st: st} }

// Redeem 原子兑换：先抢占（unused→used），校验过期，再按 grantType 分派；任一失败回滚抢占（码保持 unused）。
func (s *Service) Redeem(code, userID string) error {
	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		res := tx.Model(&model.Redemption{}).
			Where("code = ? AND status = ?", code, "unused").
			Updates(map[string]any{"status": "used", "used_by": userID, "used_at": &now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrInvalidCode
		}
		var r model.Redemption
		if err := tx.First(&r, "code = ?", code).Error; err != nil {
			return err
		}
		if r.ExpiresAt != nil && now.After(*r.ExpiresAt) {
			return ErrCodeExpired // 回滚抢占
		}
		gt := r.GrantType
		if gt == "" {
			gt = "BALANCE"
		}
		switch gt {
		case "BALANCE":
			points := r.Points
			if r.GrantPayload != "" {
				var p struct {
					Points int64 `json:"points"`
				}
				if err := json.Unmarshal([]byte(r.GrantPayload), &p); err != nil {
					return err
				}
				if p.Points > 0 {
					points = p.Points
				}
			}
			return addBalanceTx(tx, userID, points)
		case "MEMBERSHIP":
			var p struct {
				Tier string `json:"tier"`
				Days int    `json:"days"`
			}
			if err := json.Unmarshal([]byte(r.GrantPayload), &p); err != nil {
				return err
			}
			return sub.GrantInTx(tx, userID, p.Tier, p.Days)
		default: // FEATURE | PACKAGE
			return ErrUnsupportedGrant
		}
	})
}

// addBalanceTx 在事务内发一个永久桶（BALANCE 兑换）。
func addBalanceTx(tx *gorm.DB, userID string, points int64) error {
	return bucket.GrantPoints(tx, userID, points, nil, "redeem")
}
