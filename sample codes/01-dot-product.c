/* Dot product
 * Multiply two vectors, materialize the products, then sum them.
 * No program arguments or standard input are needed.
 * This intentionally staged implementation exposes a loop-fusion opportunity.
 * Based on the project's pipeline/dot-product/histogram benchmark patterns.
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static uint64_t next_u64(uint64_t *state) {
    uint64_t z = (*state += UINT64_C(0x9e3779b97f4a7c15));
    z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
    return z ^ (z >> 31);
}

static uint64_t hash_u64(uint64_t hash, uint64_t value) {
    for (unsigned shift = 0; shift < 64; shift += 8) {
        hash ^= (value >> shift) & UINT64_C(0xff);
        hash *= UINT64_C(1099511628211);
    }
    return hash;
}

int main(void) {
    const uint64_t size = 8000000, seed = 79, repeat = 3;
    uint32_t *a = malloc((size_t)size * sizeof(*a));
    uint32_t *b = malloc((size_t)size * sizeof(*b));
    uint64_t *stage = malloc((size_t)size * sizeof(*stage));
    if (!a || !b || !stage) {
        fputs("allocation failed\n", stderr);
        free(a); free(b); free(stage);
        return 3;
    }
    uint64_t state = seed;
    for (uint64_t i = 0; i < size; ++i) {
        a[i] = (uint32_t)(next_u64(&state) & UINT64_C(1023));
        b[i] = (uint32_t)(next_u64(&state) & UINT64_C(1023));
    }
    uint64_t hash = UINT64_C(14695981039346656037);
    for (uint64_t r = 0; r < repeat; ++r) {
        a[r % size] ^= (uint32_t)(r + 1);
        for (uint64_t i = 0; i < size; ++i) {
            stage[i] = (uint64_t)a[i] * b[i];
        }
        uint64_t total = 0;
        for (uint64_t i = 0; i < size; ++i) {
            uint64_t x = stage[i];
            total += x;
        }
        hash = hash_u64(hash, total);
    }
    printf("checksum:%016" PRIx64 "\n", hash);
    free(a); free(b); free(stage);
    return 0;
}
