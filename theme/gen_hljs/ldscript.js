hljs.registerLanguage("ldscript", function () {
  return {
    name: 'GNU linker script',
    aliases: ['ld'],
    case_insensitive: false,
    keywords: {
      $pattern: /\.?[a-zA-Z]\w*/,
      keyword: ["OUTPUT_ARCH", "ENTRY", "SECTIONS", "ALIGN", "STARTUP", "SEATCH_DIR", "INCLUDE", "PROVIDE"],
      // meta: [],
      built_in: ["/DISCARD/", ".text", ".srodata", ".rodata", ".sdata", ".data", ".sbss", ".bss"]
    },
    contains: [
      hljs.COMMENT('#', '$'),
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      {
        scope: 'number',
        variants: [
          { // hex
            begin: '0x[0-9a-f]+'
          },
          { // bin
            begin: '0b[01]+'
          },
          { // dec
            begin: '(?<![\\w.])-?(0|[1-9]\\d*)(k|K|m|M|g|G)?(?![:\\w])'
          },
          {
            // float
            begin: '\\b-?\\d+\\.\\d+'
          }
        ],
        relevance: 0
      },
      {
        className: 'symbol',
        begin: /'\.?[a-zA-Z_][a-zA-Z0-9_]*/,
        relevance: 0
      }
    ]
  }
});