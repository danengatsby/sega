SHELL := /usr/bin/env bash

.DEFAULT_GOAL := help

.PHONY: help smoke ci-smoke ci-smoke-down

help:
	@echo "Available targets:"
	@echo "  make smoke         - build + start backend + ANAF smoke + stop backend"
	@echo "  make ci-smoke      - start DB + push schema + ANAF smoke one-shot"
	@echo "  make ci-smoke-down - stop local DB containers"

smoke:
	npm run anaf:smoke:up

ci-smoke:
	npm run db:up
	npm run db:push
	npm run anaf:smoke:up

ci-smoke-down:
	npm run db:down
