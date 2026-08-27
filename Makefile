.PHONY: help demo network stats chart reputation discovery real-archive \
        containers node node-down node-shell lightning-up lightning-down lightning-demo lightning-smoke \
        all-stdlib clean install uninstall test test-e2e

PYTHON ?= python3
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin

help:
	@echo "censorship-resistant video PoC — real mechanisms behind the #all-pdx brainstorm"
	@echo ""
	@echo "Pure stdlib (no setup needed):"
	@echo "  make demo           poc_challenge_auction.py — possession-gated auction, narrated"
	@echo "  make network        poc_network_challenge.py — real sockets, single-shot rounds"
	@echo "  make stats          poc_network_challenge.py stats — repeated-challenge separation"
	@echo "  make discovery      poc_discovery.py — 3 real relays, personalized ranking, sybil test"
	@echo "  make all-stdlib     the four above, in sequence"
	@echo ""
	@echo "Needs pip install cryptography / matplotlib:"
	@echo "  make reputation     poc_reputation.py — signed attestations + revocation"
	@echo "  make chart          viz_challenge_separation.py — regenerates the README chart"
	@echo ""
	@echo "Needs docker/podman compose:"
	@echo "  make containers     same challenge test, real containers instead of loopback"
	@echo "  make node           web_ui.py + its own local discovery relay, port 8080 — host/discover/download from a browser"
	@echo "  make node-down      stop both containers (data survives — see docker-compose.node.yml)"
	@echo "  make node-shell     interactive weed shell inside the running node container"
	@echo ""
	@echo "Needs the lightning/ stack up (see lightning/README.md for one-time channel setup):"
	@echo "  make lightning-up    start bitcoind + 2 LND nodes on regtest"
	@echo "  make lightning-demo  poc_challenge_auction.py --lightning — real HTLC settlement"
	@echo "  make lightning-smoke lightning_settle.py standalone — one real test payment"
	@echo "  make lightning-down  tear down the lightning stack (drops chain state + wallets)"
	@echo ""
	@echo "Needs real_archive/ set up (see README.md 'real .ott archive' section):"
	@echo "  make real-archive   poc_real_archive_challenge.py — real video, real 3324 chunks"
	@echo ""
	@echo "Needs pip install -e .[dev]:"
	@echo "  make test           unit/integration suite (tests/) — fast, no browser, no Docker"
	@echo "  make test-e2e       + tests/e2e/ — real browser against a real relay+host+web UI"
	@echo "                      (needs pytest-playwright + a Chromium binary; see tests/e2e/conftest.py)"
	@echo ""
	@echo "  make clean          remove __pycache__, generated chart, tmp reputation stores"
	@echo ""
	@echo "  make install        symlink weed.py to $(BINDIR)/weed (override with PREFIX=...)"
	@echo "  make uninstall      remove $(BINDIR)/weed"

demo:
	$(PYTHON) poc_challenge_auction.py

network:
	$(PYTHON) poc_network_challenge.py

stats:
	$(PYTHON) poc_network_challenge.py stats

discovery:
	$(PYTHON) poc_discovery.py

all-stdlib: demo network stats discovery

reputation:
	$(PYTHON) poc_reputation.py

chart:
	$(PYTHON) viz_challenge_separation.py

containers:
	docker compose up --build --abort-on-container-exit verifier
	docker compose down

node:
	GIT_COMMIT=$$(git rev-parse --short HEAD 2>/dev/null) docker compose -f docker-compose.node.yml up --build

node-down:
	docker compose -f docker-compose.node.yml down

node-shell:
	docker compose -f docker-compose.node.yml exec node python3 weed.py

lightning-up:
	cd lightning && docker compose up -d
	@echo "one-time channel setup still needed the first time — see lightning/README.md"

lightning-down:
	cd lightning && docker compose down -v

lightning-demo:
	$(PYTHON) poc_challenge_auction.py --lightning

lightning-smoke:
	$(PYTHON) lightning_settle.py

real-archive:
	$(PYTHON) poc_real_archive_challenge.py

test:
	$(PYTHON) -m pytest tests --ignore=tests/e2e

test-e2e:
	$(PYTHON) -m pytest tests

clean:
	find . -name '__pycache__' -type d -exec rm -rf {} +
	find . -name '*.pyc' -delete
	rm -f /tmp/poc_rep_alice.json /tmp/poc_rep_bob.json

install:
	mkdir -p $(BINDIR)
	ln -sf $(CURDIR)/weed.py $(BINDIR)/weed
	@echo "installed: $(BINDIR)/weed -> $(CURDIR)/weed.py"
	@case ":$$PATH:" in \
		*":$(BINDIR):"*) ;; \
		*) echo "note: $(BINDIR) is not on your PATH" ;; \
	esac

uninstall:
	rm -f $(BINDIR)/weed
