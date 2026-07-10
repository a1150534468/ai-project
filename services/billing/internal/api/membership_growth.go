package api

import (
	"time"

	"gorm.io/gorm"
	"yc-billing/internal/model"
	"yc-billing/internal/resource"
	"yc-billing/internal/store"
	"yc-billing/internal/vip"
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
