export PYTHONUTF8=1

.PHONY: install dev train report test docker clean-models

install:
	pip install -r backend/requirements.txt

dev:
	cd backend && python -m uvicorn app.main:app --reload --reload-dir app --port 8000

train:
	cd backend && python -m app.ml.train

report:
	cd backend && python -m app.ml.evaluate

test:
	cd backend && python -m pytest -q

docker:
	docker compose up --build

clean-models:
	rm -rf models reports
