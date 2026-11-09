# Barangay Dashboard Context Diagram

```mermaid
flowchart LR
    users["Dashboard users<br/>Tanod · Barangay Captain · Admin"]
    camera["ESP32-CAM<br/>Live MJPEG stream"]
    mysql[("MySQL<br/>Users, cameras, incidents,<br/>tasks, announcements, recordings")]
    ffmpeg["FFmpeg<br/>Clip encoding and segmentation"]
    storage[("Recording storage<br/>MP4 clips on dashboard host")]

    subgraph dashboard["Barangay Monitoring Dashboard"]
        app["Web dashboard and Node.js API"]
        recorder["Background camera recorder"]
    end

    users -->|Login, view live feed and footage,<br/>manage records by role| app
    app -->|Dashboard pages, camera stream,<br/>reports and clip playback| users
    app <-->|Accounts, camera settings,<br/>incidents, tasks, events, clip index| mysql
    camera -->|MJPEG video stream| app
    camera -->|MJPEG video stream| recorder
    recorder -->|Encode and split into MP4 clips| ffmpeg
    ffmpeg -->|Segmented recordings| storage
    recorder -->|Index completed clips| mysql
    app -->|Read and stream selected clips| storage
```

The dashboard displays the ESP32-CAM stream directly. The background recorder reads that stream independently, creates segmented MP4 files, and indexes completed clips so signed-in users can find and preview them under **Past Footage**.
