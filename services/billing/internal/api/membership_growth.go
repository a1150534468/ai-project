package api

import (
	"time"

	"gorm.io/gorm"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/resource"
	"ai-assistant-billing/internal/store"
	"ai-assistant-billing/internal/vip"
)

func (h *Handler) activateMembershipOrderInTx(tx *gorm.DB, order *model.TopUp, now time.Time) error {
	card, err := h.membership.GetCardTx(tx, order.CardID)
	if err != nil {
		return err
	}
	if err := h.membership.ActivateInTx(tx, order.UserID, card, now); err != nil {
		return err
	}

	growth := resource.New(&store.Store{DB: tx}).PointsForAmount(order.AmountFen)
	if growth <= 0 {
		return nil
	}
	_, _, err = vip.New(tx).AddGrowthInTx(tx, vip.AddGrowthInput{
		OperationID:    "membership:" + order.TradeNo,
		UserID:         order.UserID,
		SourceType:     "membership_purchase",
		GrowthPoints:   growth,
		RelatedTradeNo: order.TradeNo,
		Note:           "membership payment growth",
		OccurredAt:     now,
	})
	return err
}
