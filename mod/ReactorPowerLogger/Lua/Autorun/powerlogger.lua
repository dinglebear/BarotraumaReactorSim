-- Reactor Power Logger (client-side, needs Lua For Barotrauma / LuaCs with client-side Lua).
-- Every round it records how much power the main submarine's reactor grid asks for and writes
-- one CSV per round. Drop the CSV into the simulator's load_profiles/ folder to replay it.
--
-- Columns: t (s), demand (kW the ship's devices ask for, battery charging excluded),
--          load (kW the reactor grid load incl. battery charging), reactor_out (kW), turbine (%),
--          fission (%), temp (0-100), fuel (sum of rod condition %), voltage, batt_in (kW charging), batt_out (kW)
if SERVER then return end

local modPath = ...
local PL = {
    sampleInterval = 0.25,   -- seconds between samples
    heartbeat = 5,           -- always write a row at least this often (otherwise only when demand changes)
    flushInterval = 30,      -- rewrite the file this often so a crash loses little
    changeThreshold = 0.5,   -- kW change that counts as "changed"
}

local active, rows, roundTime, lastReal, nextSample, lastRowT, lastDemand, nextFlush, filePath, header

local function log(msg) print("[PowerLogger] " .. msg) end

local function logDir()
    local base = (type(modPath) == "string" and modPath ~= "") and modPath or "LocalMods/ReactorPowerLogger"
    local dir = base .. "/Logs"
    pcall(function() if not File.DirectoryExists(dir) then File.CreateDirectory(dir) end end)
    return dir
end

local function mainReactors()
    local list = {}
    local sub = Submarine.MainSub
    for item in Item.ItemList do
        if item.Submarine == sub and item.Condition > 0 then
            local r = item.GetComponentString("Reactor")
            if r ~= nil then table.insert(list, r) end
        end
    end
    return list
end

local function powerOutConn(reactor)
    for c in reactor.Item.Connections do
        if c.IsPower and c.IsOutput then return c end
    end
    return nil
end

-- grid numbers for the reactor's power_out grid (nil-safe: falls back to the reactor's own Load)
local function gridInfo(reactor)
    local info = { load = reactor.Load, power = -reactor.CurrPowerConsumption, voltage = 1, battIn = 0, battOut = 0 }
    local ok = pcall(function()
        local conn = powerOutConn(reactor)
        local grid = conn and conn.Grid
        if grid == nil then return end
        info.load, info.power, info.voltage = grid.Load, grid.Power, grid.Voltage
        local seen = {}
        for c in grid.Connections do
            local pc = c.Item.GetComponentString("PowerContainer")
            if pc ~= nil then
                if c.Name == "power_in" then info.battIn = info.battIn + math.max(0, pc.CurrPowerConsumption) end
                if c.Name == "power_out" and not seen[pc] then info.battOut = info.battOut + pc.CurrPowerOutput; seen[pc] = true end
            end
        end
    end)
    if not ok then info.voltage = -1 end
    return info
end

local function fmt(n) return string.format("%.1f", n or 0) end

local function flush()
    if not active or filePath == nil then return end
    local ok, err = pcall(function() File.Write(filePath, header .. table.concat(rows, "\n") .. "\n") end)
    if not ok then log("could not write " .. tostring(filePath) .. ": " .. tostring(err)) end
end

local function startRound()
    local reactors = mainReactors()
    if #reactors == 0 then log("no reactor on the main sub, not recording"); active = false; return end
    local maxKW, maxEach = 0, {}
    for _, r in ipairs(reactors) do maxKW = maxKW + r.MaxPowerOutput; table.insert(maxEach, fmt(r.MaxPowerOutput)) end
    local subName = (Submarine.MainSub and Submarine.MainSub.Info and Submarine.MainSub.Info.Name) or "unknown"
    local safe = tostring(subName):gsub("[^%w_%-]", "_")
    local dir = logDir()
    local n = 1
    while File.Exists(string.format("%s/%s_round%03d.csv", dir, safe, n)) do n = n + 1 end
    filePath = string.format("%s/%s_round%03d.csv", dir, safe, n)
    local rods = 0
    pcall(function() for _ in reactors[1].Item.OwnInventory.AllItems do rods = rods + 1 end end)
    header = "# BaroPowerLog v1\n"
        .. "# sub=" .. tostring(subName) .. "\n"
        .. "# reactor_max_kw=" .. fmt(maxKW) .. "\n"
        .. "# reactors=" .. #reactors .. " (" .. table.concat(maxEach, "+") .. ")\n"
        .. "# fuel_rods=" .. rods .. "\n"
        .. "# fuel_consumption_rate=" .. fmt(reactors[1].FuelConsumptionRate) .. "\n"
        .. "t,demand,load,reactor_out,turbine,fission,temp,fuel,voltage,batt_in,batt_out\n"
    rows, roundTime, lastReal, nextSample, lastRowT, lastDemand, nextFlush = {}, 0, Timer.GetTime(), 0, -1e9, nil, PL.flushInterval
    active = true
    log("recording " .. tostring(subName) .. " (max " .. fmt(maxKW) .. " kW) -> " .. filePath)
end

local function stopRound()
    if not active then return end
    table.insert(rows, "# duration=" .. fmt(roundTime))
    flush()
    log("saved " .. #rows .. " rows to " .. tostring(filePath))
    active = false
end

Hook.Add("roundStart", "PowerLogger.roundStart", function() startRound() end)
Hook.Add("roundEnd", "PowerLogger.roundEnd", function() stopRound() end)

Hook.Add("think", "PowerLogger.think", function()
    if not active then return end
    local now = Timer.GetTime()
    local dt = now - lastReal
    lastReal = now
    if Game.Paused or dt <= 0 then return end
    roundTime = roundTime + math.min(dt, 0.1)  -- pauses / hitches don't stretch the timeline
    if roundTime < nextSample then return end
    nextSample = roundTime + PL.sampleInterval

    local reactors = mainReactors()
    if #reactors == 0 then return end
    local r = reactors[1]
    local g = gridInfo(r)
    local out, turbine, fission, temp, fuel = 0, 0, 0, 0, 0 -- fuel = sum of rod condition % (AvailableFuel reads 0 between ticks)
    for _, rr in ipairs(reactors) do out = out + (-rr.CurrPowerConsumption) end
    turbine, fission, temp = r.TurbineOutput, r.FissionRate, r.Temperature
    pcall(function() for rod in r.Item.OwnInventory.AllItems do fuel = fuel + rod.ConditionPercentage end end)
    local demand = math.max(0, g.load - g.battIn)

    if lastDemand == nil or math.abs(demand - lastDemand) >= PL.changeThreshold or roundTime - lastRowT >= PL.heartbeat then
        table.insert(rows, table.concat({ string.format("%.2f", roundTime), fmt(demand), fmt(g.load), fmt(out), fmt(turbine), fmt(fission), fmt(temp), fmt(fuel), string.format("%.3f", g.voltage), fmt(g.battIn), fmt(g.battOut) }, ","))
        lastDemand, lastRowT = demand, roundTime
    end
    if roundTime >= nextFlush then nextFlush = roundTime + PL.flushInterval; flush() end
end)

-- started mid-round (e.g. "reloadlua")
if Game.RoundStarted then startRound() end
