package dev.panestra.bridge

internal object UpdatePolicy {
    fun isNewer(candidate: String, current: String): Boolean {
        fun parts(value: String): List<Long> {
            require(value.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+"))) { "更新版本格式不正确" }
            return value.split('.').map { it.toLong() }
        }
        val next = parts(candidate)
        val installed = parts(current)
        for (index in 0..2) if (next[index] != installed[index]) return next[index] > installed[index]
        return false
    }
    fun validateIdentity(
        installedPackage: String, candidatePackage: String,
        expectedVersion: String, candidateVersion: String?,
        installedCode: Long, candidateCode: Long,
        installedSignatures: Set<String>?, candidateSignatures: Set<String>?
    ) {
        require(candidatePackage == installedPackage && candidateVersion == expectedVersion &&
            candidateCode > installedCode) { "更新包与当前应用不匹配，或版本没有提升" }
        require(installedSignatures != null && installedSignatures.isNotEmpty() &&
            installedSignatures == candidateSignatures) { "更新签名与当前应用不匹配" }
    }

    fun validateIntegrity(expectedSize: Long, received: Long, expectedDigest: String, actualDigest: String) {
        require(expectedSize in 1..268435456L && expectedSize == received &&
            expectedDigest.matches(Regex("sha256:[a-f0-9]{64}")) &&
            actualDigest == expectedDigest.removePrefix("sha256:")) {
            "更新完整性校验失败，当前版本未更改"
        }
    }
}
