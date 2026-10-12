#![no_std]

#[link(wasm_import_module = "host")]
unsafe extern "C" {
    fn open_socket();
    fn send_text(pointer: *const u8, length: usize);
}

#[unsafe(no_mangle)]
pub extern "C" fn start() {
    unsafe { open_socket() };
}

#[unsafe(no_mangle)]
pub extern "C" fn on_open() {
    let message = b"rust-wasm-local-probe";
    unsafe { send_text(message.as_ptr(), message.len()) };
}

#[panic_handler]
fn panic(_information: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
