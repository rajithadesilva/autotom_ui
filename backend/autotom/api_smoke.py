"""Exercise the live API queue and restore the editor configuration immediately."""
import copy
import json
import time
import urllib.request

BASE = "http://api:8000/api"


def request(path, method="GET", body=None):
    req = urllib.request.Request(BASE+path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def main():
    original = request("/config")
    config = copy.deepcopy(original["config"])
    config["simulation"]["days"] = 3
    config["simulation"]["rays"] = 1000000
    saved = request("/config", "PUT", {"revision": original["revision"], "config": config})
    try:
        run = request("/runs", "POST", {"revision": saved["revision"], "name": "GPU validation · 3 days"})
    finally:
        request("/config", "PUT", {"revision": saved["revision"], "config": original["config"]})
    print("Submitted", run["id"], "(editor configuration restored)", flush=True)
    deadline, current = time.monotonic()+1200, -1
    while time.monotonic() < deadline:
        run = request("/runs/"+run["id"])
        if run["current_day"] != current:
            current = run["current_day"]
            print(run["status"], f"{current}/{run['days']}", flush=True)
        if run["status"] in ("failed", "completed", "cancelled"):
            print(json.dumps({k: run[k] for k in ("id", "status", "current_day", "error")}, indent=2))
            if run["status"] != "completed":
                print(request(f"/runs/{run['id']}/logs")["text"][-8000:])
                raise SystemExit(1)
            return
        time.sleep(1)
    raise SystemExit("Live API smoke run exceeded 20 minutes")


if __name__ == "__main__":
    main()
