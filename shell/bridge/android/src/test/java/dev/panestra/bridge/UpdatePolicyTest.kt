package dev.panestra.bridge

import org.junit.Test
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse

class UpdatePolicyTest {
    @Test fun acceptedUpgradeKeepsApplicationAndSigner() {
        assertTrue(UpdatePolicy.isNewer("0.1.10", "0.1.9"))
        assertFalse(UpdatePolicy.isNewer("0.1.10", "0.1.10"))
        assertFalse(UpdatePolicy.isNewer("0.1.9", "0.1.10"))
        UpdatePolicy.validateIdentity("dev.panestra.app", "dev.panestra.app", "0.1.11", "0.1.11",
            1010, 1011, setOf("publisher"), setOf("publisher"))
        UpdatePolicy.validateIntegrity(123, 123, "sha256:" + "a".repeat(64), "a".repeat(64))
    }

    @Test fun rejectsOtherAppsOldVersionsChangedSignersAndMissingSignatures() {
        for (code in listOf(1009L, 1010L)) {
            assertThrows(IllegalArgumentException::class.java) {
                UpdatePolicy.validateIdentity("dev.panestra.app", "dev.panestra.app", "0.1.11", "0.1.11",
                    1010, code, setOf("publisher"), setOf("publisher"))
            }
        }
        for ((app, version, signer) in listOf(
            Triple("other.app", "0.1.11", setOf("publisher")),
            Triple("dev.panestra.app", "0.1.12", setOf("publisher")),
            Triple("dev.panestra.app", "0.1.11", setOf("attacker")),
            Triple("dev.panestra.app", "0.1.11", emptySet<String>())
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                UpdatePolicy.validateIdentity("dev.panestra.app", app, "0.1.11", version,
                    1010, 1011, setOf("publisher"), signer)
            }
        }
    }

    @Test fun rejectsTruncatedTamperedAndOversizedDownloads() {
        for ((size, received, actual) in listOf(Triple(123L, 122L, "a".repeat(64)),
            Triple(123L, 123L, "b".repeat(64)), Triple(268435457L, 268435457L, "a".repeat(64)))) {
            assertThrows(IllegalArgumentException::class.java) {
                UpdatePolicy.validateIntegrity(size, received, "sha256:" + "a".repeat(64), actual)
            }
        }
    }
}
