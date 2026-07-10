package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yc-billing/internal/model"
)

func TestTopupOrderStatusIsScopedToUserAndTradeNo(t *testing.T) {
	st := openAPISQLiteStore(t)
	paidAt := time.Now()
	if err := st.DB.Create(&model.TopUp{
		TradeNo:       "yc123",
		UserID:        "u1",
		AmountFen:     100,
		Points:        100,
		Provider:      "epay",
		PaymentMethod: "wxpay",
		Status:        "success",
		Kind:          "points",
		CreatedAt:     paidAt.Add(-time.Minute),
		PaidAt:        &paidAt,
	}).Error; err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	New(st, "test-token", nil).Register(r)

	req := httptest.NewRequest(http.MethodGet, "/topup/u1/yc123", nil)
	req.Header.Set("X-Internal-Token", "test-token")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Data struct {
			TradeNo       string `json:"tradeNo"`
			UserID        string `json:"userId"`
			PaymentMethod string `json:"paymentMethod"`
			Status        string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v", err)
	}
	if body.Data.TradeNo != "yc123" || body.Data.UserID != "u1" || body.Data.PaymentMethod != "wxpay" || body.Data.Status != "success" {
		t.Fatalf("unexpected body: %+v", body.Data)
	}

	req = httptest.NewRequest(http.MethodGet, "/topup/u2/yc123", nil)
	req.Header.Set("X-Internal-Token", "test-token")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("other user must not read order, status=%d body=%s", w.Code, w.Body.String())
	}
}
