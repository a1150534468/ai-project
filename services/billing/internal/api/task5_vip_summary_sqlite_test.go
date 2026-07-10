package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVipSummaryEndpointReturnsProgress(t *testing.T) {
	r, token, _ := openTask5Handler(t)

	req := httptest.NewRequest(http.MethodGet, "/vip/me/u1", nil)
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var body struct {
		Data struct {
			LevelName         string `json:"levelName"`
			DiscountBps       int    `json:"discountBps"`
			GrowthPoints      int64  `json:"growthPoints"`
			PointsToNextLevel int64  `json:"pointsToNextLevel"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.LevelName != "普通会员" || body.Data.DiscountBps != 10000 {
		t.Fatalf("bad vip summary: %+v", body.Data)
	}
}
