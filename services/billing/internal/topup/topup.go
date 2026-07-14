package topup

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"ai-assistant-billing/internal/bucket"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/videopoint"
)

// Service 充值服务：下单 + 到账
type Service struct {
	st *store.Store
}

// New 创建充值服务
func New(st *store.Store) *Service {
	return &Service{st: st}
}

// CreateOrder 创建充值订单（待支付状态）
func (s *Service) CreateOrder(o *model.TopUp) error {
	o.Status = "pending"
	o.CreatedAt = time.Now()
	return s.st.DB.Create(o).Error
}

// CreditByTradeNoWith 根据交易号到账：
// 1. 行级锁（SELECT FOR UPDATE）序列化同一订单的并发回调
// 2. 状态门：仅 pending → success（幂等防重复）
// 3. 按 Kind 分派：kind=points 用 bucket.GrantPoints；kind=membership 调 onMembership 回调
// 4. 订单不存在或已成功返回 nil（幂等）
func (s *Service) CreditByTradeNoWith(tradeNo, method string, onMembership func(tx *gorm.DB, o *model.TopUp) error) error {
	return s.st.DB.Transaction(func(tx *gorm.DB) error {
		var o model.TopUp

		// 行级锁：确保同一订单的并发回调串行化
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&o, "trade_no = ?", tradeNo).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				// 订单不存在：幂等返回（网关回调时不报错，回执 success）
				return nil
			}
			return err
		}

		// 状态门：已成功则幂等退出
		if o.Status != "pending" {
			return nil
		}

		// 更新订单状态为 success，记录支付方式和到账时间
		now := time.Now()
		if err := tx.Model(&o).Updates(map[string]any{
			"status":         "success",
			"payment_method": method,
			"paid_at":        &now,
		}).Error; err != nil {
			return err
		}

		// 到账分派
		if o.Kind == "membership" {
			if onMembership == nil {
				return errors.New("membership order needs handler")
			}
			return onMembership(tx, &o)
		}
		if o.Kind == videopoint.TopUpKind {
			return videopoint.CreditInTx(tx, o.UserID, o.Points)
		}
		// kind=points 或默认
		ratio := resource.New(&store.Store{DB: tx}).RechargeRatio()
		paidPoints := o.AmountFen * ratio / 100
		if paidPoints < 0 {
			paidPoints = 0
		}
		if paidPoints > o.Points {
			paidPoints = o.Points
		}
		giftPoints := o.Points - paidPoints
		if giftPoints < 0 {
			giftPoints = 0
		}
		if paidPoints > 0 {
			if err := bucket.GrantPoints(tx, o.UserID, paidPoints, nil, bucket.SourceTopupPaid); err != nil {
				return err
			}
		}
		if giftPoints > 0 {
			if err := bucket.GrantPoints(tx, o.UserID, giftPoints, nil, bucket.SourceTopupGift); err != nil {
				return err
			}
		}
		return nil
	})
}

// CreditByTradeNo 根据交易号到账（points 订单）
func (s *Service) CreditByTradeNo(tradeNo, method string) error {
	return s.CreditByTradeNoWith(tradeNo, method, nil)
}
