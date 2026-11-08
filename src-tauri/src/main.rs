// no console window next to the app on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    model_painter_lib::run()
}
