# QWAV JPCUB Pre-Registration

**WBS:** QWAV.PLT.JPCUB.P3
**Author:** QNFO Research Collective
**Date:** 2026-08-06
**Status:** Draft — Genre C (Internal/Operations)
**Parent:** JPCUB P0 (DOI 10.5281/zenodo.21637028), CL v2.0 (DOI 10.5281/zenodo.21821767)

---

## 1. Purpose

QWAV's JPCUB design target ($<10^{-3}$ J/solution for factoring $N = 15$ at $\varepsilon = 0.95$) currently appears on the competitive landscape as a positional entry alongside measured and model-derived values. This creates a credibility asymmetry: the entity proposing the universal benchmark also claims the best possible score.

Per the JPCUB strategic assessment (session Lix-MUWJTX69KVWScl01C, 2026-08-06), this conflict of interest must be resolved by **pre-registering the target with a hard deadline and a penalty clause** before QWAV hardware enters the landscape as a measured entry.

## 2. Pre-Registration Statement

> QWAV's current JPCUB entry is a **design target**, not a measured value. We pre-register the following:
>
> 1. **Target:** $J_{\text{QWAV}}(T, \varepsilon) < 10^{-3}$ J/solution for the JPCUB standard task $T$ (factoring $N = 15 = 3 \times 5$ using Shor's algorithm, correctness threshold $\varepsilon = 0.95$).
>
> 2. **Methodology:** The measurement will follow the JPCUB P0 protocol §3 (incremental energy above idle baseline for comparability with the published IBM Eagle value of 0.89 J/sol), with measurement uncertainty documented per P0 §4 anti-gaming provisions.
>
> 3. **Deadline for first measurement:** When QWAV physical hardware completes characterization sufficient to execute the standard 80-gate factoring circuit.
>
> 4. **Penalty clause:** If the measured JPCUB value exceeds the design target by more than a factor of 10 (i.e., $J_{\text{QWAV}} > 10^{-2}$ J/sol), QWAV will:
>    - (a) Publicly acknowledge the miss, explaining which cost driver (power, speed, or success probability) caused the deviation
>    - (b) Update the competitive landscape entry to the measured value within 30 days
>    - (c) Publish a post-mortem analysis identifying the architectural assumptions that failed
>
> 5. **If the measured JPCUB value is within the target:** QWAV will publish the full measurement protocol, raw data, and uncertainty analysis for independent adversarial validation per P0 §4.2.

## 3. Visual Separation

Until physical hardware is measured, the QWAV entry on the JPCUB competitive landscape MUST:

1. **Be visually separated** from measured and model-derived entries (distinct row styling, color, or section)
2. **Carry an explicit label:** `[DESIGN TARGET — NOT MEASURED; no evidential weight]`
3. **Not be ranked** among measured entries — it must appear in a separate "Pre-Commercial / Design Targets" section
4. **Include the penalty clause** as a footnote or linked reference

## 4. Design Target Derivation

The $<10^{-3}$ J/sol target is derived from three architectural premises:

| Premise | JPCUB Impact | Status |
|:--------|:-------------|:-------|
| **Room-temperature operation** | $P_{\text{sys}} < 0.1$ kW (eliminates 10–25 kW cryogenic draw) | `[architectural constant — derived from p-adic encoding per Ostrowski's theorem]` |
| **Qudit encoding** ($d = 7^3 = 343$ states per qudit) | Reduces gate count for equivalent computation vs. qubit encoding | `[architectural constant]` |
| **Intrinsic error protection** | Eliminates active QEC overhead ($10^2$–$10^6$ physical-to-logical qubit ratio) | `[architectural constant — not empirically demonstrated]` |

**Conservative bound:** The target assumes $P_{\text{sys}} = 0.1$ kW, $t_{\text{exec}} = 10$ μs (competitive with neutral-atom gates), and $p_{\text{succ}} = 0.95$. This yields:

$$J_{\text{QWAV}} = \frac{100 \text{ W} \times 10^{-5} \text{ s}}{0.95} = 1.05 \times 10^{-3} \text{ J/sol}$$

The $<10^{-3}$ target is therefore a factor-of-1.05 safety margin above this conservative bound. If any premise fails (e.g., $P_{\text{sys}}$ is 10× higher due to control electronics), the JPCUB will exceed $10^{-2}$ and the penalty clause triggers.

## 5. Measurement Readiness Criteria

Before measurement can proceed:

1. **Hardware must execute the 80-gate factoring circuit** end-to-end
2. **Gate fidelity must be characterized** via randomized benchmarking or equivalent
3. **System power must be measured** at the wall plug (including all control electronics, lasers, and I/O)
4. **Success probability must be empirically measured** over at least 100 shots
5. **Third-party verification** — an independent entity must witness the measurement or reproduce it remotely (cloud-accessible QWAV hardware)

## 6. Calibration Register

```
[CHECK: 2028] QWAV hardware will have completed sufficient characterization for a JPCUB measurement.
Strength: [SPECULATIVE] | Status: [PENDING]

[CHECK: 2028] QWAV measured JPCUB will be within 10× of the $<10^{-3}$ J/sol design target.
Strength: [SPECULATIVE] | Status: [PENDING]

[CHECK: 2029] At least one non-QNFO entity will have independently verified a QWAV JPCUB measurement.
Strength: [WEAK] | Status: [PENDING]
```

## 7. Registration Hash

This document is pre-registered with the following hash (to be computed at publication time):

```
sha256: <PENDING — compute at Zenodo deposit>
```

## References

1. JPCUB P0: DOI 10.5281/zenodo.21637028
2. JPCUB CL v2.0: DOI 10.5281/zenodo.21821767
3. JPCUB Strategic Assessment: Session Lix-MUWJTX69KVWScl01C (2026-08-06)
