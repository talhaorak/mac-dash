use serde::Serialize;
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, RefreshKind, System};
use std::sync::Mutex;
use std::time::Instant;

#[derive(Serialize, Clone)]
pub struct CpuStats {
    pub user: f32,
    pub sys: f32,
    pub idle: f32,
    pub model: String,
    pub cores: usize,
    pub load_avg: [f64; 3],
}

#[derive(Serialize, Clone)]
pub struct MemoryStats {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub wired: u64,
    pub compressed: u64,
    pub used_percent: f64,
}

#[derive(Serialize, Clone)]
pub struct DiskStats {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub used_percent: f64,
    pub mount_point: String,
}

#[derive(Serialize, Clone)]
pub struct SystemStats {
    pub cpu: CpuStats,
    pub memory: MemoryStats,
    pub disk: DiskStats,
    pub uptime: String,
    pub hostname: String,
    pub os_version: String,
    pub process_count: usize,
    pub thread_count: usize,
}

#[derive(Serialize, Clone)]
pub struct HardwareInfo {
    pub model: String,
    pub cpu: String,
    pub cores: usize,
    pub memory: u64,
    pub os_version: String,
    pub hostname: String,
    pub serial_number: Option<String>,
}

static SYS: std::sync::LazyLock<Mutex<(System, Instant)>> = std::sync::LazyLock::new(|| {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    std::thread::sleep(std::time::Duration::from_millis(200));
    sys.refresh_cpu_all();
    sys.refresh_memory_specifics(MemoryRefreshKind::everything());
    Mutex::new((sys, Instant::now()))
});

fn format_uptime(secs: u64) -> String {
    let days = secs / 86400;
    let hours = (secs % 86400) / 3600;
    let mins = (secs % 3600) / 60;
    if days > 0 {
        format!("{}d {}h {}m", days, hours, mins)
    } else if hours > 0 {
        format!("{}h {}m", hours, mins)
    } else {
        format!("{}m", mins)
    }
}

pub fn get_system_stats() -> SystemStats {
    let mut guard = SYS.lock().unwrap();
    let (sys, last) = &mut *guard;

    // Only refresh CPU if >500ms since last refresh
    if last.elapsed().as_millis() > 500 {
        sys.refresh_cpu_all();
        sys.refresh_memory_specifics(MemoryRefreshKind::everything());
        *last = Instant::now();
    }

    let cpus = sys.cpus();
    let cpu_count = cpus.len();
    let mut total_usage: f32 = 0.0;
    let cpu_model = cpus.first().map(|c| c.brand().to_string()).unwrap_or_default();
    for cpu in cpus {
        total_usage += cpu.cpu_usage();
    }
    let avg_usage = if cpu_count > 0 { total_usage / cpu_count as f32 } else { 0.0 };
    let user = (avg_usage * 0.6 * 10.0).round() / 10.0;
    let sys_usage = (avg_usage * 0.4 * 10.0).round() / 10.0;
    let idle = ((100.0 - avg_usage) * 10.0).round() / 10.0;

    let load_avg = System::load_average();

    let total_mem = sys.total_memory();
    let used_mem = sys.used_memory();
    let free_mem = sys.free_memory();
    let used_pct = if total_mem > 0 { (used_mem as f64 / total_mem as f64) * 100.0 } else { 0.0 };

    // Disk info
    let disks = Disks::new_with_refreshed_list();
    let root_disk = disks.iter().find(|d| d.mount_point() == std::path::Path::new("/"));
    let (disk_total, disk_free) = root_disk
        .map(|d| (d.total_space(), d.available_space()))
        .unwrap_or((0, 0));
    let disk_used = disk_total.saturating_sub(disk_free);

    SystemStats {
        cpu: CpuStats {
            user,
            sys: sys_usage,
            idle,
            model: cpu_model,
            cores: cpu_count,
            load_avg: [load_avg.one, load_avg.five, load_avg.fifteen],
        },
        memory: MemoryStats {
            total: total_mem,
            used: used_mem,
            free: free_mem,
            wired: 0,       // sysinfo doesn't split wired/compressed
            compressed: 0,
            used_percent: used_pct,
        },
        disk: DiskStats {
            total: disk_total,
            used: disk_used,
            free: disk_free,
            used_percent: if disk_total > 0 { (disk_used as f64 / disk_total as f64) * 100.0 } else { 0.0 },
            mount_point: "/".into(),
        },
        uptime: format_uptime(System::uptime()),
        hostname: System::host_name().unwrap_or_else(|| "localhost".into()),
        os_version: System::os_version().unwrap_or_else(|| "unknown".into()),
        process_count: sys.processes().len(),
        thread_count: 0,
    }
}

pub fn get_hardware_info() -> HardwareInfo {
    let guard = SYS.lock().unwrap();
    let (sys, _) = &*guard;

    let cpus = sys.cpus();
    let cpu_model = cpus.first().map(|c| c.brand().to_string()).unwrap_or_default();
    let model = if cpu_model.contains("Apple") { "Apple Silicon Mac" } else { "Intel Mac" };

    HardwareInfo {
        model: model.into(),
        cpu: cpu_model.clone(),
        cores: cpus.len(),
        memory: sys.total_memory(),
        os_version: System::os_version().unwrap_or_else(|| "unknown".into()),
        hostname: System::host_name().unwrap_or_else(|| "localhost".into()),
        serial_number: None,
    }
}
