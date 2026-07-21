package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"ai-assistant-billing/internal/registry"
	"ai-assistant-billing/internal/vip"
)

type upsertVipLevelReq struct {
	ID              uint   `json:"id"`
	Name            string `json:"name" binding:"required"`
	SortOrder       int    `json:"sortOrder"`
	ThresholdRMBFen int64  `json:"thresholdRmbFen"`
	DiscountBps     int    `json:"discountBps" binding:"required"`
	Enabled         bool   `json:"enabled"`
	UpgradeEnabled  bool   `json:"upgradeEnabled"`
}

type deleteVipLevelReq struct {
	ID uint `json:"id" binding:"required"`
}

type marketplaceMetaReq struct {
	Description          *string `json:"description"`
	CapabilityTags       *string `json:"tags"`
	Category             *string `json:"category"`
	ContextWindow        *int64  `json:"contextLength"`
	MaxOutputTokens      *int64  `json:"maxOutputTokens"`
	UseCases             *string `json:"useCases"`
	MarketplaceSortOrder *int    `json:"sortOrder"`
	ShowInMarketplace    *bool   `json:"showInMarketplace"`
}

func (h *Handler) updateModelMarketplaceIfProvided(modelName string, input marketplaceMetaReq) error {
	return h.registry.UpdateMarketplaceFields(modelName, registry.MarketplaceMetaPatch{
		Description:          input.Description,
		CapabilityTags:       input.CapabilityTags,
		Category:             input.Category,
		ContextWindow:        input.ContextWindow,
		MaxOutputTokens:      input.MaxOutputTokens,
		UseCases:             input.UseCases,
		MarketplaceSortOrder: input.MarketplaceSortOrder,
		ShowInMarketplace:    input.ShowInMarketplace,
	})
}

func (h *Handler) adminListVipLevels(c *gin.Context) {
	if err := vip.New(h.st.DB).EnsureDefaultLevels(h.resource.RechargeRatio()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip seed failed"})
		return
	}
	rows, err := vip.New(h.st.DB).ListLevels(false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rows})
}

func (h *Handler) adminUpsertVipLevel(c *gin.Context) {
	var req upsertVipLevelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := vip.New(h.st.DB).EnsureDefaultLevels(h.resource.RechargeRatio()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vip seed failed"})
		return
	}
	row, err := vip.New(h.st.DB).UpsertLevel(vip.UpsertLevelInput{
		ID:              req.ID,
		Name:            req.Name,
		SortOrder:       req.SortOrder,
		ThresholdRMBFen: req.ThresholdRMBFen,
		RechargeRatio:   h.resource.RechargeRatio(),
		DiscountBps:     req.DiscountBps,
		Enabled:         req.Enabled,
		UpgradeEnabled:  req.UpgradeEnabled,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid vip level"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": row})
}

func (h *Handler) adminDeleteVipLevel(c *gin.Context) {
	var req deleteVipLevelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid params"})
		return
	}
	if err := vip.New(h.st.DB).DeleteLevel(req.ID); err != nil {
		if errors.Is(err, vip.ErrLevelOccupied) {
			c.JSON(http.StatusConflict, gin.H{"error": "vip level occupied"})
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "vip level not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "delete failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
