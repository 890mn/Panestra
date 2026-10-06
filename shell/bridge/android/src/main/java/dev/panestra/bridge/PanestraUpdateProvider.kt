package dev.panestra.bridge

// A distinct provider avoids merging with the shell's general FileProvider.
class PanestraUpdateProvider : androidx.core.content.FileProvider()
