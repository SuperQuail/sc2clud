// Package apperr 定义业务错误的唯一类型。
// platform 下的其它包不 import 本包：错误码是业务概念，缓存/队列/数据库没有 code。
package apperr

import "net/http"

// Error 是 handler 唯一认识的错误类型。
// Code 是前后端唯一约定（v2 §21.4），handler 不许自己造码。
type Error struct {
	Code   string
	Status int
	Msg    string
	Fields map[string]string // 仅 common.invalid_input 用，key 是 JSON 字段名
}

func (e *Error) Error() string { return e.Code }

// New 造一个业务错误。Msg 是给用户看的中文，可以改；Code 一旦发布就不能改。
func New(code string, status int, msg string) *Error {
	return &Error{Code: code, Status: status, Msg: msg}
}

// Invalid 是参数校验失败的唯一出口：code=common.invalid_input, status=400。
func Invalid(fields map[string]string) *Error {
	return &Error{Code: CodeInvalidInput, Status: http.StatusBadRequest, Msg: "参数错误", Fields: fields}
}

// WithMsg 返回同一 code/status 的副本，换一句给用户看的话。
// 只用于「同一个码在不同场景要说清是哪一处」——不要拿它造新码。
func (e *Error) WithMsg(msg string) *Error {
	return &Error{Code: e.Code, Status: e.Status, Msg: msg, Fields: e.Fields}
}

// WithFields 给已有错误挂上字段级说明（仍然要求 code 是 common.invalid_input）。
func (e *Error) WithFields(fields map[string]string) *Error {
	return &Error{Code: e.Code, Status: e.Status, Msg: e.Msg, Fields: fields}
}
