# GreedyGuy — Makefile
# Builds CLI binary and static library

CC       ?= gcc
AR       ?= ar
CFLAGS   ?= -O3 -march=native -flto -Wall -Wextra
LDFLAGS  ?= -lm

PREFIX   ?= /usr/local
BINDIR   ?= $(PREFIX)/bin
LIBDIR   ?= $(PREFIX)/lib
INCDIR   ?= $(PREFIX)/include

# Targets
CLI      = greedyguy
LIB      = libgreedyguy.a
LIB_OBJ  = gg_lib.o

.PHONY: all clean install uninstall test

all: $(CLI) $(LIB)

# CLI binary (standalone)
$(CLI): greedyguy.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

# Library object (no main, no CLI code)
$(LIB_OBJ): src/gg_lib.c greedyguy.c include/greedyguy.h
	$(CC) $(CFLAGS) -I. -Iinclude -c -o $@ src/gg_lib.c

# Static library
$(LIB): $(LIB_OBJ)
	$(AR) rcs $@ $<

# Roundtrip test
test: $(CLI)
	@echo "=== Roundtrip Test ==="
	@echo "Hello GreedyGuy!" > /tmp/gg_test_input.txt
	@./$(CLI) c /tmp/gg_test_input.txt /tmp/gg_test_compressed.gg
	@./$(CLI) d /tmp/gg_test_compressed.gg /tmp/gg_test_output.txt
	@diff /tmp/gg_test_input.txt /tmp/gg_test_output.txt && echo "PASS: roundtrip OK" || echo "FAIL: data mismatch"
	@echo "=== Pipe Test ==="
	@echo "Pipe test data" | ./$(CLI) pc | ./$(CLI) pd > /tmp/gg_pipe_out.txt
	@echo "Pipe test data" > /tmp/gg_pipe_expected.txt
	@diff /tmp/gg_pipe_expected.txt /tmp/gg_pipe_out.txt && echo "PASS: pipe roundtrip OK" || echo "FAIL: pipe mismatch"
	@rm -f /tmp/gg_test_*.txt /tmp/gg_test_*.gg /tmp/gg_pipe_*.txt

install: $(CLI) $(LIB) include/greedyguy.h
	install -d $(BINDIR) $(LIBDIR) $(INCDIR)
	install -m 755 $(CLI) $(BINDIR)/
	install -m 644 $(LIB) $(LIBDIR)/
	install -m 644 include/greedyguy.h $(INCDIR)/

uninstall:
	rm -f $(BINDIR)/$(CLI) $(LIBDIR)/$(LIB) $(INCDIR)/greedyguy.h

clean:
	rm -f $(CLI) $(LIB) $(LIB_OBJ)
