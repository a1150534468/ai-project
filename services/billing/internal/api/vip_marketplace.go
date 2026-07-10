package api

import (
	"math"
	"net/http"

	"github.com/gin-gonic/gin"
	"yc-billing/internal/model"
	"yc-billing/internal/vip"
)

func (h *Handler) vipSummary(c *gin.Context) {
	if err := vip.New(h.st.DB).EnsureDefaultLevels(h.resource.RechargeRatio()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip seed failed"})
		return
	}
	summary, err := vip.New(h.st.DB).Summary(c.Param("userId"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip summary failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": summary})
}

func (h *Handler) modelMarketplace(c *gin.Context) {
	userID := c.Param("userId")
	if err := vip.New(h.st.DB).EnsureDefaultLevels(h.resource.RechargeRatio()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip seed failed"})
		return
	}
	summary, err := vip.New(h.st.DB).Summary(userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip summary failed"})
		return
	}
	rows, err := h.registry.ListMarketplace()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "marketplace failed"})
		return
	}

	type priceView struct {
		Original   float64 `json:"original"`
		Discounted int64   `json:"discounted"`
	}
	type rowView struct {
		model.PriceRule
		VipInputPrice       priceView `json:"vipInputPrice"`
		VipOutputPrice      priceView `json:"vipOutputPrice"`
		VipCacheInputPrice  priceView `json:"vipCacheInputPrice"`
		VipCacheOutputPrice priceView `json:"vipCacheOutputPrice"`
	}

	out := make([]rowView, 0, len(rows))
	for _, row := range rows {
		out = append(out, rowView{
			PriceRule: row,
			VipInputPrice: priceView{
				Original:   row.InputPricePerMillion,
				Discounted: vip.DiscountedPoints(int64(math.Ceil(row.InputPricePerMillion)), summary.DiscountBps),
			},
			VipOutputPrice: priceView{
				Original:   row.OutputPricePerMillion,
				Discounted: vip.DiscountedPoints(int64(math.Ceil(row.OutputPricePerMillion)), summary.DiscountBps),
			},
			VipCacheInputPrice: priceView{
				Original:   row.CacheInputPricePerMillion,
				Discounted: vip.DiscountedPoints(int64(math.Ceil(row.CacheInputPricePerMillion)), summary.DiscountBps),
			},
			VipCacheOutputPrice: priceView{
				Original:   row.CacheOutputPricePerMillion,
				Discounted: vip.DiscountedPoints(int64(math.Ceil(row.CacheOutputPricePerMillion)), summary.DiscountBps),
			},
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out, "vip": summary})
}
