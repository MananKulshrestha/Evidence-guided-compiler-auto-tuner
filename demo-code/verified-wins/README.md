# Five measured local-tuning examples

Measured on 27 October 2026 with the unchanged Quick code runner and LLVM 21 on this machine.

These are new programs adapted from the project's staged-loop, dot-product, and histogram benchmark patterns, not five pre-existing independently winning benchmark algorithms. They compute different results but intentionally share the loop-fusion opportunity. Ten variants were screened and these five were selected; this is a demonstration set, not a representative evaluation.

## How to run

1. Load any one `.c` file into the source box.
2. Clear **Program arguments** and **Standard input**. Both stay empty for all five files.
3. Keep **Maximum suggested passes** at 4, then click **Quick**.
4. Read the guided/O3 runtime cards and output check. Do not use Full runtime benchmark.

Each complete C17 program contains its own main, deterministic input generation, eight million elements, and three repetitions. No external libraries or input files are needed. Every measured executable matched O0 and O3 stdout. Every final source was remeasured after screening, with four local candidates and five alternating confirmation rounds.

## Fresh confirmation results

| Source | Computation | O3 median | Guided median | Runtime reduction | Faster paired rounds |
|---|---|---:|---:|---:|---:|
| [01-dot-product.c](01-dot-product.c) | Dot product | 73.18 ms | 59.34 ms | 18.91% | 5/5 |
| [02-squared-error.c](02-squared-error.c) | Sum of squared errors | 80.59 ms | 62.59 ms | 22.33% | 4/5 |
| [03-thresholded-signal.c](03-thresholded-signal.c) | Thresholded signal accumulation | 81.44 ms | 64.38 ms | 20.95% | 5/5 |
| [04-signal-energy.c](04-signal-energy.c) | Signal energy after gain | 80.89 ms | 61.52 ms | 23.96% | 5/5 |
| [05-feature-histogram.c](05-feature-histogram.c) | Histogram of XOR features | 83.14 ms | 68.12 ms | 18.06% | 5/5 |

Results can vary with machine load, toolchain, or source/input changes. These are quick observations on one fixed input, not a guarantee or a held-out performance claim. A five-round quick result is not the full benchmark's ten-round win label.

`results.json` summarizes the measurements. Each matching `.json` file contains the exact submitted source, source hash, all raw executions, output hashes, selected passes, and compiler commands. Scratch build paths in the commands were temporary and have been cleaned up.
