# GreedyGuy v2: Mixture-of-Experts + Novel AI Compression Research

## Current Architecture (GG v1)
- 11 state-table context models (order 0-8 + HTML + word)
- 1 running-match model
- Single-layer logistic mixer (12 inputs → 1 output)
- Dual APM correction stages
- c0/c1 counter states with halving

## Research Findings

### 1. PAQ/CMIX Architecture (State of the Art)

**PAQ8** (top-tier compressor):
- 256-state table per context (not just c0/c1 counts — tracks exact sequences for ≤4 bits, count pairs + last-bit for 5-15, count pairs for 16-41)
- Context-selected weight sets (use small context to pick which mixer weights to use)
- Multiple mixer layers (PAQAR introduced cascaded mixers)
- SSE (Secondary Symbol Estimation) = our APM but with better context selection

**CMIX v21** (best non-neural compressor):
- 2,077 independent models
- 3-layer neural network mixer (Gated Linear Network)
- LSTM byte-level mixer on top for inter-byte dependencies
- Dictionary-based text preprocessing
- 32GB RAM, but achieves enwik8: 14.6MB (1.17 bpb)

**Key insight**: More models + deeper mixing + better state tables = better compression.

### 2. Mixture of Experts (MoE) for Compression

**Concept**: Instead of mixing all models equally, use a gating network to dynamically route each prediction to the most relevant "expert" models.

**Architecture for GreedyGuy v2**:
```
                    ┌─────────────┐
                    │ Gating Net  │ ← context (html_state, byte_class, recent_entropy)
                    │ (softmax)   │
                    └──┬──┬──┬──┬─┘
                       │  │  │  │  (expert weights)
                    ┌──▼──▼──▼──▼─┐
        ┌───────────┤  Expert MoE  ├───────────┐
        │           └──────────────┘           │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐  ┌───▼────┐
   │ Expert 0 │  │ Expert 1 │  │ Expert 2 │  │Expert 3│
   │ Text/NL  │  │ Markup   │  │ Code     │  │ Binary │
   │ Models   │  │ Models   │  │ Models   │  │ Models │
   └─────────┘  └─────────┘  └─────────┘  └────────┘
```

**Expert 0 (Natural Language)**: word model, order-6/8, prev-word context
**Expert 1 (Markup/Tags)**: HTML state, tag model, bracket depth, attribute model
**Expert 2 (Code/Syntax)**: keyword model, indent model, bracket/paren model
**Expert 3 (Structured Data)**: repeat model, column model, numeric pattern model

**Gating signals**:
- HTML state machine output (are we in tag, text, attribute?)
- Recent byte class distribution (alpha, digit, punct, whitespace)
- Local entropy estimate (are bytes predictable or random?)
- Repeat distance (are we in a repetitive section?)

### 3. PAQ8-Style 256-State Table (HIGH IMPACT)

Current GG: each context maps to {c0, c1} (2 bytes, simple counting)
PAQ8: each context maps to 1 byte (0-255), with a carefully designed state transition table.

**PAQ8 state encoding**:
- States 0-14: exact bit sequences (≤4 bits) — perfect memory for short contexts
- States 15-248: (n0, n1, last_bit) triples with limited counts
- State transitions are precomputed: next_state[state][bit] → new_state
- Each state maps to a probability via a 256-entry table that adapts online

**Why this is better**:
1. Perfect recall for first 4 bits → eliminates cold-start noise
2. last_bit tracking → better recency modeling
3. More nuanced count representation → 256 possible probability levels vs our continuous but noisy counts
4. Single byte per entry → cache-friendly, uses less memory for same table size

**Implementation**: Replace StateEntry {c0, c1} with uint8_t state. Use precomputed next_state[256][2] and state_to_prob[256] tables.

### 4. Multi-Layer Mixing (HIGH IMPACT)

Current GG: 1 mixer layer → APM1 → APM2 → output
PAQ8/CMIX: Multiple mixer layers with different context selections

**Proposed 3-layer architecture**:
```
Layer 0: N individual model predictions
    ↓
Layer 1: K context-selected mixers (each mixes all N inputs)
    Contexts: (byte_class × bit_pos), html_state, ...
    ↓
Layer 2: 1 master mixer (mixes K layer-1 outputs)
    ↓
SSE/APM correction → final probability
```

This works because different contexts benefit from different weightings of the same models. E.g., when inside an HTML tag, the tag model should be weighted high; when in text content, the word model dominates.

### 5. LSTM Byte-Level Mixer (CMIX-STYLE, MEDIUM IMPACT)

After encoding each byte (8 bits), use a small LSTM to predict the *distribution* of the next byte, and blend this with the bit-level prediction.

**Feasible in C**: A tiny LSTM (hidden_size=64, ~16KB weights) that:
- Takes last byte as input (one-hot or embedding)
- Outputs 256 logits (next-byte distribution)
- During bit-level coding, these logits provide a byte-level prior that the bit-level mixer can blend

**Speed concern**: One forward pass per byte, not per bit. 256×64 matrix multiply = ~16K multiply-adds per byte. At 100MB/s that's ~1.6 GFLOP/s — feasible.

### 6. Gated Linear Networks (GLN, DeepMind)

**Key paper**: "Gated Linear Networks" (Veness et al., 2017)

A GLN is a multi-layer network where:
- Each neuron is a logistic regressor
- The gating function selects which weight set each neuron uses
- Online learning with provable convergence guarantees
- No backpropagation needed — each neuron independently minimizes log loss

**Why perfect for compression**:
- Online learning (no training phase needed)
- Each layer independently minimizes prediction error
- Data-conditioning replaces nonlinear activations → interpretable
- Proven to converge to optimal predictor

**Architecture**: Replace our single logistic mixer with a 2-3 layer GLN.

### 7. Sparse Context Models (PAQ TECHNIQUE)

Current GG: only consecutive byte contexts (order-0 through order-8)
PAQ: also uses "sparse" contexts with gaps

**Examples**:
- Context of bytes at positions [-2, -4] (skip every other)
- Context of bytes at positions [-1, -3, -5] (odd positions)
- Context of bytes at positions [-1, stride, 2×stride] (for tabular data)

**For HTML**: The byte two characters before `>` and the byte after `<` are highly correlated even with varying tag lengths between them.

### 8. Indirect Context Models (NEW)

Instead of hashing context bytes directly, hash the *predictions* of other models as context.

**Example**: Use the quantized output of the order-2 model as context for an "indirect" model. This captures "when order-2 predicts 70%, what actually happens?" — effectively learning the calibration errors of each model.

### 9. LLM-Guided Preprocessing

**Research finding** (Delétang et al., 2023): Chinchilla 70B compresses ImageNet to 43.4% — beating PNG (58.5%). The prediction-compression equivalence means any good predictor IS a good compressor.

**Practical approach for GG**:
- We can't run a 70B model, but we can pre-train a tiny Transformer (1M params) offline on a corpus of HTML/CSS/JS
- Export the trained weights into the compressor header (~4KB compressed)
- Use the pre-trained model as an additional expert in the MoE

### 10. Byte-Class Conditioned Models

Classify each byte into a class: alpha, digit, whitespace, punct, control, high-byte.
Use byte_class as an additional context dimension for all models.

This is cheap (1 lookup per byte) but gives every model knowledge about "what type of data are we processing?"

## Implementation Priority (Impact × Feasibility)

| # | Technique | Impact | Effort | Priority |
|---|-----------|--------|--------|----------|
| 1 | PAQ8 256-state table | HIGH | Medium | ★★★★★ |
| 2 | Multi-layer mixing (3 layers) | HIGH | Medium | ★★★★★ |
| 3 | Context-selected weight sets | HIGH | Low | ★★★★☆ |
| 4 | Sparse context models | MEDIUM | Low | ★★★★☆ |
| 5 | Byte-class conditioning | MEDIUM | Low | ★★★★☆ |
| 6 | MoE gating network | HIGH | High | ★★★☆☆ |
| 7 | Indirect context models | MEDIUM | Medium | ★★★☆☆ |
| 8 | GLN (Gated Linear Network) | HIGH | High | ★★★☆☆ |
| 9 | LSTM byte-level mixer | MEDIUM | High | ★★☆☆☆ |
| 10 | Pre-trained Transformer | HIGH | Very High | ★★☆☆☆ |

## Proposed GreedyGuy v2 Architecture

```
Input byte stream
    │
    ▼
┌──────────────────────────────────┐
│         Context Engine           │
│  history[], html_state, word,    │
│  byte_class, sparse_ctx,         │
│  match_finder, repeat_detector   │
└──────┬──────┬──────┬──────┬──────┘
       │      │      │      │
   ┌───▼──┐┌──▼──┐┌──▼──┐┌──▼───┐
   │Model ││Model││Model││Model │    20+ models total
   │ 0-4  ││ 5-9 ││10-14││15-19 │    (order-N, sparse, HTML,
   │      ││     ││     ││      │     word, match, indirect)
   └──┬───┘└──┬──┘└──┬──┘└──┬───┘
      │       │      │      │
      └───┬───┘      └──┬───┘
          │             │
   ┌──────▼─────┐ ┌────▼──────┐
   │  Mixer L1  │ │ Mixer L1  │    Context-selected weights
   │  (ctx A)   │ │ (ctx B)   │    A = byte_class × bit_pos
   └──────┬─────┘ └────┬──────┘    B = html_state × bit_pos
          │            │
          └─────┬──────┘
          ┌─────▼──────┐
          │  Mixer L2  │           Master mixer
          │  (master)  │
          └─────┬──────┘
                │
          ┌─────▼──────┐
          │    SSE 1   │           APM with prev_byte context
          └─────┬──────┘
                │
          ┌─────▼──────┐
          │    SSE 2   │           APM with bit_pos context
          └─────┬──────┘
                │
          ┌─────▼──────┐
          │   Output   │ ──────► Range Coder
          └────────────┘
```

## Expected Improvement Estimates

| Change | Expected gain |
|--------|--------------|
| 256-state table | -3 to -5% compressed size |
| Multi-layer mixing | -2 to -4% |
| Context-selected weights | -1 to -3% |
| Sparse models | -1 to -2% |
| Byte-class conditioning | -0.5 to -1% |
| Combined | -8 to -15% total |

On our HTML test: 11,032 → ~9,400-10,100 bytes (estimated)
