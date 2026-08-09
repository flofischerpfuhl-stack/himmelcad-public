/*
 * Minimal ILP64 CBLAS bridge for the Windows NumPy 2.2.6 runtime.
 *
 * NumPy's official Windows extensions import only this subset of CBLAS.  The
 * implementation delegates to NumPy's bundled, BSD-licensed f2c BLAS and is
 * deliberately kept independent of OpenBLAS, Fortran and OpenMP runtimes.
 */
#include <stdint.h>

typedef int64_t blasint;
typedef struct { float r, i; } complex32;
typedef struct { double r, i; } complex64;

enum { CblasRowMajor = 101, CblasColMajor = 102 };
enum { CblasNoTrans = 111, CblasTrans = 112, CblasConjTrans = 113 };
enum { CblasUpper = 121, CblasLower = 122 };

#define REAL_BLAS(prefix, type, dot_type) \
    extern int prefix##axpy_(blasint *, type *, type *, blasint *, type *, blasint *); \
    extern dot_type prefix##dot_(blasint *, type *, blasint *, type *, blasint *); \
    extern int prefix##gemv_(char *, blasint *, blasint *, type *, type *, blasint *, type *, blasint *, type *, type *, blasint *); \
    extern int prefix##gemm_(char *, char *, blasint *, blasint *, blasint *, type *, type *, blasint *, type *, blasint *, type *, type *, blasint *); \
    extern int prefix##syrk_(char *, char *, blasint *, blasint *, type *, type *, blasint *, type *, type *, blasint *)

#define COMPLEX_BLAS(prefix, type) \
    extern int prefix##axpy_(blasint *, type *, type *, blasint *, type *, blasint *); \
    extern void prefix##dotc_(type *, blasint *, type *, blasint *, type *, blasint *); \
    extern void prefix##dotu_(type *, blasint *, type *, blasint *, type *, blasint *); \
    extern int prefix##gemv_(char *, blasint *, blasint *, type *, type *, blasint *, type *, blasint *, type *, type *, blasint *); \
    extern int prefix##gemm_(char *, char *, blasint *, blasint *, blasint *, type *, type *, blasint *, type *, blasint *, type *, type *, blasint *)

REAL_BLAS(s, float, double);
REAL_BLAS(d, double, double);
COMPLEX_BLAS(c, complex32);
COMPLEX_BLAS(z, complex64);

static char trans_char(int trans) {
    return trans == CblasNoTrans ? 'N' : (trans == CblasTrans ? 'T' : 'C');
}

static char row_gemv_trans(int trans) {
    return trans == CblasNoTrans ? 'T' : 'N';
}

static char uplo_char(int uplo) { return uplo == CblasUpper ? 'U' : 'L'; }
static char reverse_uplo(int uplo) { return uplo == CblasUpper ? 'L' : 'U'; }
static char row_syrk_trans(int trans) { return trans == CblasNoTrans ? 'T' : 'N'; }

#define DEFINE_REAL_CBLAS(tag, prefix, type, dot_type) \
void scipy_cblas_##tag##axpy64_(blasint n, type alpha, const type *x, blasint incx, type *y, blasint incy) { \
    prefix##axpy_(&n, &alpha, (type *)x, &incx, y, &incy); \
} \
type scipy_cblas_##tag##dot64_(blasint n, const type *x, blasint incx, const type *y, blasint incy) { \
    return (type)(dot_type)prefix##dot_(&n, (type *)x, &incx, (type *)y, &incy); \
} \
void scipy_cblas_##tag##gemv64_(int order, int trans, blasint m, blasint n, type alpha, const type *a, blasint lda, const type *x, blasint incx, type beta, type *y, blasint incy) { \
    char t; \
    if (order == CblasRowMajor) { t = row_gemv_trans(trans); prefix##gemv_(&t, &n, &m, &alpha, (type *)a, &lda, (type *)x, &incx, &beta, y, &incy); } \
    else { t = trans_char(trans); prefix##gemv_(&t, &m, &n, &alpha, (type *)a, &lda, (type *)x, &incx, &beta, y, &incy); } \
} \
void scipy_cblas_##tag##gemm64_(int order, int transa, int transb, blasint m, blasint n, blasint k, type alpha, const type *a, blasint lda, const type *b, blasint ldb, type beta, type *c, blasint ldc) { \
    char ta = trans_char(transa), tb = trans_char(transb); \
    if (order == CblasRowMajor) prefix##gemm_(&tb, &ta, &n, &m, &k, &alpha, (type *)b, &ldb, (type *)a, &lda, &beta, c, &ldc); \
    else prefix##gemm_(&ta, &tb, &m, &n, &k, &alpha, (type *)a, &lda, (type *)b, &ldb, &beta, c, &ldc); \
} \
void scipy_cblas_##tag##syrk64_(int order, int uplo, int trans, blasint n, blasint k, type alpha, const type *a, blasint lda, type beta, type *c, blasint ldc) { \
    char u = order == CblasRowMajor ? reverse_uplo(uplo) : uplo_char(uplo); \
    char t = order == CblasRowMajor ? row_syrk_trans(trans) : trans_char(trans); \
    prefix##syrk_(&u, &t, &n, &k, &alpha, (type *)a, &lda, &beta, c, &ldc); \
}

DEFINE_REAL_CBLAS(s, s, float, double)
DEFINE_REAL_CBLAS(d, d, double, double)

#define DEFINE_COMPLEX_MATH(tag, type, scalar) \
static type tag##_add(type a, type b) { type r = {a.r + b.r, a.i + b.i}; return r; } \
static type tag##_mul(type a, type b) { type r = {a.r*b.r - a.i*b.i, a.r*b.i + a.i*b.r}; return r; } \
static type tag##_conj(type a) { type r = {a.r, -a.i}; return r; } \
static void tag##_row_conj_gemv(blasint m, blasint n, const type *alpha, const type *a, blasint lda, const type *x, blasint incx, const type *beta, type *y, blasint incy) { \
    const type *x0 = incx < 0 ? x + (1 - m) * incx : x; \
    type *y0 = incy < 0 ? y + (1 - n) * incy : y; \
    for (blasint j = 0; j < n; ++j) { \
        type sum = {(scalar)0, (scalar)0}; \
        for (blasint i = 0; i < m; ++i) sum = tag##_add(sum, tag##_mul(tag##_conj(a[i * lda + j]), x0[i * incx])); \
        y0[j * incy] = tag##_add(tag##_mul(*alpha, sum), tag##_mul(*beta, y0[j * incy])); \
    } \
} \
static void tag##_syrk(int order, int uplo, int trans, blasint n, blasint k, const type *alpha, const type *a, blasint lda, const type *beta, type *c, blasint ldc) { \
    for (blasint i = 0; i < n; ++i) { \
        blasint first = uplo == CblasUpper ? i : 0; \
        blasint last = uplo == CblasUpper ? n : i + 1; \
        for (blasint j = first; j < last; ++j) { \
            type sum = {(scalar)0, (scalar)0}; \
            for (blasint p = 0; p < k; ++p) { \
                blasint ai = order == CblasRowMajor \
                    ? (trans == CblasNoTrans ? i * lda + p : p * lda + i) \
                    : (trans == CblasNoTrans ? i + p * lda : p + i * lda); \
                blasint aj = order == CblasRowMajor \
                    ? (trans == CblasNoTrans ? j * lda + p : p * lda + j) \
                    : (trans == CblasNoTrans ? j + p * lda : p + j * lda); \
                sum = tag##_add(sum, tag##_mul(a[ai], a[aj])); \
            } \
            blasint ci = order == CblasRowMajor ? i * ldc + j : i + j * ldc; \
            c[ci] = tag##_add(tag##_mul(*alpha, sum), tag##_mul(*beta, c[ci])); \
        } \
    } \
}

DEFINE_COMPLEX_MATH(c32, complex32, float)
DEFINE_COMPLEX_MATH(c64, complex64, double)

#define DEFINE_COMPLEX_CBLAS(tag, prefix, type, math_tag) \
void scipy_cblas_##tag##axpy64_(blasint n, const type *alpha, const type *x, blasint incx, type *y, blasint incy) { \
    prefix##axpy_(&n, (type *)alpha, (type *)x, &incx, y, &incy); \
} \
void scipy_cblas_##tag##dotc_sub64_(blasint n, const type *x, blasint incx, const type *y, blasint incy, type *out) { \
    prefix##dotc_(out, &n, (type *)x, &incx, (type *)y, &incy); \
} \
void scipy_cblas_##tag##dotu_sub64_(blasint n, const type *x, blasint incx, const type *y, blasint incy, type *out) { \
    prefix##dotu_(out, &n, (type *)x, &incx, (type *)y, &incy); \
} \
void scipy_cblas_##tag##gemv64_(int order, int trans, blasint m, blasint n, const type *alpha, const type *a, blasint lda, const type *x, blasint incx, const type *beta, type *y, blasint incy) { \
    char t; \
    if (order == CblasRowMajor && trans == CblasConjTrans) { math_tag##_row_conj_gemv(m, n, alpha, a, lda, x, incx, beta, y, incy); return; } \
    if (order == CblasRowMajor) { t = row_gemv_trans(trans); prefix##gemv_(&t, &n, &m, (type *)alpha, (type *)a, &lda, (type *)x, &incx, (type *)beta, y, &incy); } \
    else { t = trans_char(trans); prefix##gemv_(&t, &m, &n, (type *)alpha, (type *)a, &lda, (type *)x, &incx, (type *)beta, y, &incy); } \
} \
void scipy_cblas_##tag##gemm64_(int order, int transa, int transb, blasint m, blasint n, blasint k, const type *alpha, const type *a, blasint lda, const type *b, blasint ldb, const type *beta, type *c, blasint ldc) { \
    char ta = trans_char(transa), tb = trans_char(transb); \
    if (order == CblasRowMajor) prefix##gemm_(&tb, &ta, &n, &m, &k, (type *)alpha, (type *)b, &ldb, (type *)a, &lda, (type *)beta, c, &ldc); \
    else prefix##gemm_(&ta, &tb, &m, &n, &k, (type *)alpha, (type *)a, &lda, (type *)b, &ldb, (type *)beta, c, &ldc); \
} \
void scipy_cblas_##tag##syrk64_(int order, int uplo, int trans, blasint n, blasint k, const type *alpha, const type *a, blasint lda, const type *beta, type *c, blasint ldc) { \
    math_tag##_syrk(order, uplo, trans, n, k, alpha, a, lda, beta, c, ldc); \
}

DEFINE_COMPLEX_CBLAS(c, c, complex32, c32)
DEFINE_COMPLEX_CBLAS(z, z, complex64, c64)

/* LAPACK reports invalid arguments through XERBLA. NumPy validates array
 * shapes before entering LAPACK, so a no-op error hook is sufficient here. */
int xerbla_(char *name, blasint *info) { (void)name; (void)info; return 0; }
