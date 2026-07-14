package pay

import (
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
)

type Epay struct {
	client       *epay.Client
	callbackBase string
}

func NewEpay(pid, key, gateway, callbackBase string) (*Epay, error) {
	if pid == "" || key == "" || gateway == "" {
		return nil, errors.New("epay 配置缺失")
	}
	c, err := epay.NewClient(&epay.Config{PartnerID: pid, Key: key}, gateway)
	if err != nil {
		return nil, err
	}
	return &Epay{client: c, callbackBase: callbackBase}, nil
}

// GenTradeNo 生成我方交易号（唯一键，幂等到账依赖）
func GenTradeNo() string {
	return fmt.Sprintf("ai%d", time.Now().UnixNano())
}

// Purchase 返回支付跳转 URL（前端渲染二维码/跳转）
// type 可为 "alipay" 或 "wxpay"
func (e *Epay) Purchase(tradeNo, name string, amountFen int64, method string) (string, error) {
	notifyURL, _ := url.Parse(e.callbackBase + "/api/billing/epay/notify")
	returnURL, _ := url.Parse(e.callbackBase + "/billing/return")

	// 将分转换为元（两位小数）
	amountYuan := fmt.Sprintf("%.2f", float64(amountFen)/100.0)

	uri, params, err := e.client.Purchase(&epay.PurchaseArgs{
		Type:           method, // "alipay" | "wxpay"
		ServiceTradeNo: tradeNo,
		Name:           name,
		Money:          amountYuan,
		Device:         epay.PC,
		NotifyUrl:      notifyURL,
		ReturnUrl:      returnURL,
	})
	if err != nil {
		return "", err
	}
	// Convert map[string]string to url.Values for encoding
	values := url.Values{}
	for k, v := range params {
		values.Set(k, v)
	}
	return uri + "?" + values.Encode(), nil
}

// Client 返回底层易支付客户端（用于回调验签）
func (e *Epay) Client() *epay.Client {
	return e.client
}
