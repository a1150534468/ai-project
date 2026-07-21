package api

import (
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"ai-assistant-billing/internal/model"
	"ai-assistant-billing/internal/vip"
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

	// 生图类模型（标签含 image-gen）按次计费：从资源价表取代表分辨率（2K）的单价，
	// 与 token 类模型一样套用 VIP 折扣展示。
	var imageResourceRows []model.ResourcePrice
	h.st.DB.Where("resource_key IN ?", []string{"image_generation_1k", "image_generation_2k", "image_generation_4k"}).
		Find(&imageResourceRows)
	imageRateByKey := make(map[string]float64, len(imageResourceRows))
	for _, r := range imageResourceRows {
		imageRateByKey[r.ResourceKey] = r.Rate
	}

	type priceView struct {
		Original   float64 `json:"original"`
		Discounted int64   `json:"discounted"`
	}
	type imagePriceView struct {
		OriginalPoints   int64  `json:"originalPoints"`
		DiscountedPoints int64  `json:"discountedPoints"`
		Resolution       string `json:"resolution"`
	}
	type rowView struct {
		model.PriceRule
		VipInputPrice       priceView       `json:"vipInputPrice"`
		VipOutputPrice      priceView       `json:"vipOutputPrice"`
		VipCacheInputPrice  priceView       `json:"vipCacheInputPrice"`
		VipCacheOutputPrice priceView       `json:"vipCacheOutputPrice"`
		ImagePrice          *imagePriceView `json:"imagePrice"`
	}

	out := make([]rowView, 0, len(rows))
	for _, row := range rows {
		rv := rowView{
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
		}
		if strings.Contains(row.CapabilityTags, "image-gen") {
			resolution, rate := "2K", imageRateByKey["image_generation_2k"]
			if rate == 0 {
				if r, ok := imageRateByKey["image_generation_1k"]; ok {
					resolution, rate = "1K", r
				} else if r, ok := imageRateByKey["image_generation_4k"]; ok {
					resolution, rate = "4K", r
				}
			}
			if rate > 0 {
				original := int64(math.Ceil(rate))
				rv.ImagePrice = &imagePriceView{
					OriginalPoints:   original,
					DiscountedPoints: vip.DiscountedPoints(original, summary.DiscountBps),
					Resolution:       resolution,
				}
			}
		}
		out = append(out, rv)
	}
	c.JSON(http.StatusOK, gin.H{"data": out, "vip": summary})
}
