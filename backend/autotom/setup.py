import argparse
import os
from pathlib import Path
from .adapter import install

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Back up and install the AutoTom adapter in a host-mounted model")
    parser.add_argument("--model", default=os.getenv("MODEL_DIR", "/model"))
    args = parser.parse_args()
    install(Path(args.model))
    print(f"AutoTom adapter installed in {args.model}; backups are in .autotom-backups/")
