use std::fs::File;

fn main() {
    let files = [
        "highlight.min.js", // https://highlightjs.org/download with bash, c, cpp, ini, plaintext, rust, Makefile, arm
        "riscvasm.min.js", // https://github.com/highlightjs/highlightjs-riscvasm
        "ldscript.min.js", // local
    ];
    let mut of = File::create("../highlight.js").unwrap();
    for fp in files {
        let mut f = File::open(fp).unwrap();
        std::io::copy(&mut f, &mut of).unwrap();
    }
}