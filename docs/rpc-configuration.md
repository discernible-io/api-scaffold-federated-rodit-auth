# Network Configuration for roditwallet.sh

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

## Problem
The script may encounter RPC errors due to:
- Rate limiting on default RPC endpoints (mainnet-fastnear)
- Network connectivity issues
- Pagoda free tier limitations

## Solution
Configure a different network config using the `NEAR_NETWORK_CONFIG` environment variable.

The NEAR CLI has built-in network configurations that you can switch between. Use `mainnet-lava` for better reliability.

## Usage

### Option 1: One-time use
```bash
export NEAR_NETWORK_CONFIG="mainnet-lava"
./roditwallet.sh <your-command>
```

### Option 2: Using configuration file
1. Copy the example configuration:
   ```bash
   cp roditwallet.env.example roditwallet.env
   ```

2. The file already has `mainnet-lava` enabled. Edit if you want a different config.

3. Source the configuration before running the script:
   ```bash
   source roditwallet.env
   ./roditwallet.sh <your-command>
   ```

### Option 3: Permanent configuration
Add to your `~/.bashrc` or `~/.profile`:
```bash
export NEAR_NETWORK_CONFIG="mainnet-lava"
```

## Available Network Configs

### For Mainnet:
- **mainnet-lava** (Lava Network - recommended for reliability)
- **mainnet-fastnear** (FastNEAR - default)

### For Testnet:
- **testnet-lava** (Lava Network testnet)
- **testnet-fastnear** (FastNEAR testnet)

To see all available configs and their RPC endpoints:
```bash
near config show-connections
```

## Testing
To verify the network configuration is working:
```bash
export NEAR_NETWORK_CONFIG="mainnet-lava"
./roditwallet.sh 76177d5ebd89f329945ab8991357018f44ab0fe12f7a8216c6054e565e80a7aa 'bc=near.org;sc=roditcorp-com.near;id=01K8QECHMM1214VMDHSH7JM6H8'
```

You should see: `Using network config: mainnet-lava` at the start of the output.

## Troubleshooting

If you still encounter errors:
1. Try a different network config (e.g., switch between mainnet-lava and mainnet-fastnear)
2. Check your internet connectivity
3. Verify the account and RODiT ID are correct
4. The script has built-in retry logic (3 attempts with 2s delay)
5. Check if the RODiT actually exists for that account (the error might be legitimate)
