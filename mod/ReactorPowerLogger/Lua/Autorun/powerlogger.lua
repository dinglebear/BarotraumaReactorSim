-- Reactor Power Logger v3 (client-side only; needs Lua For Barotrauma / LuaCs with client-side Lua).
-- Works in singleplayer and as a client in multiplayer (nothing runs on the server).
-- Every round it records how much power the main submarine asks for, what the reactor and main junction box do,
-- and the signals and situations that predict power spikes. A row is written when something changes
-- (at most 20 rows a second, big jumps always), plus a heartbeat every 5 s.
-- Drop the CSV into the simulator's load_profiles/ folder to replay the round.
--
-- Columns ("device.pin" columns are things a circuit can read in game; they become wireable pins in the simulator):
--   t                       round time (s)
--   demand                  kW the ship's devices ask for (battery charging excluded; gun supercapacitors included)
--   load, power, voltage    main junction box: load_value_out, power_value_out, power/load
--   reactor_out, turbine, fission, temp, fuel   reactor (fuel = sum of rod condition %)
--   rods, avail_fuel        fuel rods in the reactor; heat-giving fuel (80 per uranium rod with condition left)
--   autotemp, power_on, target_fission, target_turbine   control state (target = what the sliders/circuit ask for)
--   reactor_cond            reactor condition % (worn reactors catch fire/melt down sooner)
--   batt_in, batt_out       kW into / out of the ship batteries
--   batt_charge_pct, batt_rate_pct    ship batteries: average charge %, average recharge-rate setting %
--   caps_charge_pct         gun supercapacitors: average charge % (low = big recharge draw coming)
--   nav.velocity_x_out, nav.velocity_y_out      nav terminal outputs (-100..100) -> engines / ballast pumps
--   nav.current_velocity_x, nav.current_velocity_y, nav.current_position_y      nav terminal outputs (km/h, depth m)
--   engines.load_value_out, pumps.load_value_out, guns.load_value_out, sonar.load_value_out   kW per device group
--   oxygen_kw, fabricators_kw, lights_kw, other_kw   the rest of the load, by kind (4x a second)
--   autopilot               nav terminal autopilot / maintain position on (1/0)
--   enemies_near            living non-crew creatures within ~100 m of the sub (once a second): fights coming
--   flooding_pct            water in the sub's hulls, % of volume (bilge pumps)
--   jb_broken               broken junction boxes on the main sub
--   event                   what happened: rods changed, autotemp/power toggled, junction box broke, enemies arrived...
-- Footer: duration, and reactor_max_kw_formula = median of Output / (Turbine/100) (the max-output formula), as a check
-- on the reactor_max_kw read from the game.
if SERVER then return end

local modPath = ...
local PL = {
    heartbeat = 5,           -- always write a row at least this often
    minRowGap = 0.05,        -- at most 20 rows a second ...
    bigJumpKW = 50,          -- ... unless the demand jumps this much
    flushInterval = 30,      -- rewrite the file this often so a crash loses little
    rescanInterval = 10,     -- re-find devices (repairs, new items)
    slowInterval = 0.25,     -- other loads, batteries
    situationInterval = 1,   -- enemies, flooding, junction boxes
    enemyRange = 10000,      -- game units (100 units = 1 m)
}
local COLS = { "demand", "load", "power", "reactor_out", "turbine", "fission", "temp", "fuel", "rods", "avail_fuel",
    "autotemp", "power_on", "target_fission", "target_turbine", "reactor_cond",
    "voltage", "batt_in", "batt_out", "batt_charge_pct", "batt_rate_pct", "caps_charge_pct",
    "nav.velocity_x_out", "nav.velocity_y_out", "nav.current_velocity_x", "nav.current_velocity_y", "nav.current_position_y",
    "engines.load_value_out", "pumps.load_value_out", "guns.load_value_out", "sonar.load_value_out",
    "oxygen_kw", "fabricators_kw", "lights_kw", "other_kw", "autopilot", "enemies_near", "flooding_pct", "jb_broken", "event" }
-- change needed before a new row is written
local KW = { demand = true, load = true, power = true, reactor_out = true, batt_in = true, batt_out = true,
    ["engines.load_value_out"] = true, ["pumps.load_value_out"] = true, ["guns.load_value_out"] = true, ["sonar.load_value_out"] = true,
    oxygen_kw = true, fabricators_kw = true, lights_kw = true, other_kw = true }
local THRESH = { ["nav.current_velocity_x"] = 2, ["nav.current_velocity_y"] = 2, ["nav.current_position_y"] = 2,
    batt_charge_pct = 1, caps_charge_pct = 2, flooding_pct = 1, reactor_cond = 1, fuel = 1 }
local INTS = { rods = true, autotemp = true, power_on = true, avail_fuel = true, autopilot = true, enemies_near = true, jb_broken = true }
-- component kinds for the "rest of the load" columns (the device groups have their own columns)
local KIND = { OxygenGenerator = "oxygen_kw", Fabricator = "fabricators_kw", Deconstructor = "fabricators_kw", LightComponent = "lights_kw" }
local SKIP = { Reactor = true, PowerTransfer = true, PowerContainer = true, Engine = true, Pump = true, Turret = true, Sonar = true, Relay = true }
local FUELS = { fuelrod = 80, thoriumfuelrod = 100, fulguriumfuelrod = 150, fulguriumfuelrodvolatile = 150 }

local active, rows, roundTime, lastReal, lastRowT, last, nextFlush, nextScan, nextSlow, nextSit, filePath, header
local dev, slow, sit, maxEst = {}, {}, {}, {}
local pendingEvents = {}

local function log(msg) print("[PowerLogger] " .. msg) end
local function event(e) table.insert(pendingEvents, e) end

local function logDir()
    local base = (type(modPath) == "string" and modPath ~= "") and modPath or "LocalMods/ReactorPowerLogger"
    local dir = base .. "/Logs"
    pcall(function() if not File.DirectoryExists(dir) then File.CreateDirectory(dir) end end)
    return dir
end

-- find and cache the main sub's devices (iterating every item each tick would be too slow)
local function scan()
    dev = { reactors = {}, steering = nil, engines = {}, pumps = {}, batteries = {}, supercaps = {}, turrets = {}, sonars = {}, others = {}, junctions = {} }
    local sub = Submarine.MainSub
    for item in Item.ItemList do
        if item.Submarine == sub then
            local r = item.GetComponentString("Reactor")
            if r ~= nil and item.Condition > 0 then table.insert(dev.reactors, r) end
            local st = item.GetComponentString("Steering")
            if st ~= nil and dev.steering == nil then dev.steering = st end
            local e = item.GetComponentString("Engine")
            if e ~= nil then table.insert(dev.engines, e) end
            local p = item.GetComponentString("Pump")
            if p ~= nil then table.insert(dev.pumps, p) end
            local pc = item.GetComponentString("PowerContainer")
            if pc ~= nil then
                if string.find(tostring(item.Prefab.Identifier), "supercapacitor") then table.insert(dev.supercaps, pc)
                else table.insert(dev.batteries, pc) end
            end
            local t = item.GetComponentString("Turret")
            if t ~= nil then table.insert(dev.turrets, t) end
            local so = item.GetComponentString("Sonar")
            if so ~= nil then table.insert(dev.sonars, so) end
            if item.GetComponentString("PowerTransfer") ~= nil and string.find(tostring(item.Prefab.Identifier), "junction") then table.insert(dev.junctions, item) end
            -- everything else that draws power, by kind
            pcall(function()
                for comp in item.Components do
                    local name = tostring(comp.Name)
                    if not SKIP[name] then
                        local ok, cpc = pcall(function() return comp.CurrPowerConsumption end)
                        if ok and type(cpc) == "number" then table.insert(dev.others, { comp = comp, col = KIND[name] or "other_kw" }) end
                    end
                end
            end)
        end
    end
end

local function sumConsumption(list)
    local s = 0
    for _, c in ipairs(list) do s = s + math.max(0, c.CurrPowerConsumption) end
    return s
end

local function powerOutConn(reactor)
    for c in reactor.Item.Connections do
        if c.IsPower and c.IsOutput then return c end
    end
    return nil
end

-- slower-changing values, 4x a second
local function sampleSlow()
    local s = { oxygen_kw = 0, fabricators_kw = 0, lights_kw = 0, other_kw = 0 }
    for _, o in ipairs(dev.others) do
        pcall(function() s[o.col] = s[o.col] + math.max(0, o.comp.CurrPowerConsumption) end)
    end
    local function avgCharge(list)
        local c, cap, rate, n = 0, 0, 0, 0
        for _, pc in ipairs(list) do
            pcall(function()
                c = c + pc.Charge; cap = cap + pc.Capacity
                if pc.MaxRechargeSpeed > 0 then rate = rate + pc.RechargeSpeed / pc.MaxRechargeSpeed * 100; n = n + 1 end
            end)
        end
        return cap > 0 and c / cap * 100 or nil, n > 0 and rate / n or nil
    end
    s.batt_charge_pct, s.batt_rate_pct = avgCharge(dev.batteries)
    s.caps_charge_pct = avgCharge(dev.supercaps)
    pcall(function() s.autopilot = (dev.steering ~= nil and (dev.steering.AutoPilot or dev.steering.MaintainPos)) and 1 or 0 end)
    pcall(function() s.reactor_cond = dev.reactors[1].Item.ConditionPercentage end)
    slow = s
end

-- the situation around the sub, once a second
local function sampleSituation()
    local s = { enemies_near = 0, flooding_pct = 0, jb_broken = 0 }
    local sub = Submarine.MainSub
    pcall(function()
        local sp = sub.WorldPosition
        for c in Character.CharacterList do
            if not c.IsDead and not c.IsHuman and c.Submarine ~= sub then
                local p = c.WorldPosition
                local dx, dy = p.X - sp.X, p.Y - sp.Y
                if dx * dx + dy * dy < PL.enemyRange * PL.enemyRange then s.enemies_near = s.enemies_near + 1 end
            end
        end
    end)
    pcall(function()
        local water, vol = 0, 0
        for h in Hull.HullList do
            if h.Submarine == sub then water = water + h.WaterVolume; vol = vol + h.Volume end
        end
        if vol > 0 then s.flooding_pct = water / vol * 100 end
    end)
    for _, jb in ipairs(dev.junctions) do pcall(function() if jb.Condition <= 0 then s.jb_broken = s.jb_broken + 1 end end) end
    if sit.enemies_near ~= nil then
        if s.enemies_near > 0 and sit.enemies_near == 0 then event("enemies near " .. s.enemies_near) end
        if s.enemies_near == 0 and sit.enemies_near > 0 then event("enemies gone") end
        if s.jb_broken > sit.jb_broken then event("junction box broke") end
        if s.jb_broken < sit.jb_broken then event("junction box repaired") end
    end
    sit = s
end

local function sample()
    local v = {}
    local r = dev.reactors[1]
    -- main junction box = the reactor's grid
    v.load, v.power, v.voltage = r.Load, -r.CurrPowerConsumption, 1
    pcall(function()
        local conn = powerOutConn(r)
        local grid = conn and conn.Grid
        if grid ~= nil then v.load, v.power, v.voltage = grid.Load, grid.Power, grid.Voltage end
    end)
    v.batt_in, v.batt_out = 0, 0
    for _, pc in ipairs(dev.batteries) do
        v.batt_in = v.batt_in + math.max(0, pc.CurrPowerConsumption)
        v.batt_out = v.batt_out + pc.CurrPowerOutput
    end
    v.demand = math.max(0, v.load - v.batt_in)
    v.reactor_out = 0
    for _, rr in ipairs(dev.reactors) do v.reactor_out = v.reactor_out + (-rr.CurrPowerConsumption) end
    v.turbine, v.fission, v.temp = r.TurbineOutput, r.FissionRate, r.Temperature
    v.fuel, v.rods, v.avail_fuel = 0, 0, 0
    pcall(function()
        for rod in r.Item.OwnInventory.AllItems do
            v.fuel = v.fuel + rod.ConditionPercentage; v.rods = v.rods + 1
            if rod.Condition > 0 then v.avail_fuel = v.avail_fuel + (FUELS[tostring(rod.Prefab.Identifier)] or 0) end
        end
    end)
    pcall(function()
        v.autotemp = r.AutoTemp and 1 or 0; v.power_on = r.PowerOn and 1 or 0
        v.target_fission, v.target_turbine = r.TargetFissionRate, r.TargetTurbineOutput
    end)
    -- nav terminal outputs (same values the game sends on its pins)
    local st = dev.steering
    if st ~= nil then
        pcall(function()
            local tv = st.TargetVelocity
            local vx = tv.X
            if Submarine.MainSub.FlippedX then vx = -vx end
            v["nav.velocity_x_out"] = vx
            local nb = st.NeutralBallastLevel
            local sign = (tv.Y > 0 and 1) or (tv.Y < 0 and -1) or 0
            local a, b = (nb * 100 - 50) * 2, -100 * sign
            v["nav.velocity_y_out"] = a + (b - a) * (math.abs(tv.Y) / 100)
        end)
    end
    pcall(function()
        local sub = Submarine.MainSub
        v["nav.current_velocity_x"] = sub.Velocity.X * 3.6
        v["nav.current_velocity_y"] = -sub.Velocity.Y * 3.6
        v["nav.current_position_y"] = sub.RealWorldDepth
    end)
    v["engines.load_value_out"] = sumConsumption(dev.engines)
    v["pumps.load_value_out"] = sumConsumption(dev.pumps)
    v["guns.load_value_out"] = sumConsumption(dev.supercaps) + sumConsumption(dev.turrets)
    v["sonar.load_value_out"] = sumConsumption(dev.sonars)
    for k, x in pairs(slow) do v[k] = x end
    for k, x in pairs(sit) do v[k] = x end
    -- max-output formula samples: Output = Turbine/100 * Max holds while the reactor runs at its turbine limit
    if v.turbine ~= nil and v.turbine > 10 and v.reactor_out > 0 and (v.voltage or 1) < 0.98 and #maxEst < 20000 then
        table.insert(maxEst, v.reactor_out / (v.turbine / 100))
    end
    return v
end

local function changed(v)
    if last == nil then return true end
    for _, c in ipairs(COLS) do
        if c ~= "event" then
            local a, b = v[c] or 0, last[c] or 0
            local th = KW[c] and 2 or THRESH[c] or (INTS[c] and 0.5) or 0.5
            if math.abs(a - b) >= th then return true end
        end
    end
    return false
end

local function fmt(c, n)
    if n == nil then return "" end
    if c == "event" then return n end
    if KW[c] then return string.format("%.1f", n) end
    if INTS[c] then return tostring(math.floor(n + 0.5)) end
    return string.format("%.4f", n)
end

local function median(t)
    if #t == 0 then return nil end
    local s = {}
    for i, x in ipairs(t) do s[i] = x end
    table.sort(s)
    return s[math.floor(#s / 2) + 1]
end

local function footer()
    local f = "# duration=" .. string.format("%.2f", roundTime)
    local m = median(maxEst)
    if m then f = f .. "\n# reactor_max_kw_formula=" .. string.format("%.0f", m) .. " (median of Output/(Turbine/100) over " .. #maxEst .. " samples)" end
    return f
end

local function flush(final)
    if not active or filePath == nil then return end
    local ok, err = pcall(function() File.Write(filePath, header .. table.concat(rows, "\n") .. "\n" .. (final and (footer() .. "\n") or "")) end)
    if not ok then log("could not write " .. tostring(filePath) .. ": " .. tostring(err)) end
end

local function wired(item, name)
    local n = 0
    pcall(function()
        for c in item.Connections do
            if c.Name == name then for w in c.Wires do n = n + 1 end end
        end
    end)
    return n
end

local function gameInfo()
    local L = {}
    pcall(function() table.insert(L, "# mode=" .. (Game.IsMultiplayer and "multiplayer client" or "singleplayer")) end)
    pcall(function() table.insert(L, "# level_difficulty=" .. string.format("%.1f", Level.Loaded.Difficulty)) end)
    pcall(function() table.insert(L, "# biome=" .. tostring(Level.Loaded.LevelData.Biome.Identifier)) end)
    pcall(function() table.insert(L, "# level_type=" .. tostring(Level.Loaded.Type)) end)
    pcall(function()
        local m = {}
        for mission in Game.GameSession.Missions do table.insert(m, tostring(mission.Prefab.Identifier)) end
        table.insert(L, "# missions=" .. table.concat(m, " "))
    end)
    return #L > 0 and (table.concat(L, "\n") .. "\n") or ""
end

local function startRound()
    scan()
    if #dev.reactors == 0 then log("no reactor on the main sub, not recording"); active = false; return end
    local maxKW, maxEach = 0, {}
    for _, r in ipairs(dev.reactors) do
        local ok, m = pcall(function() return r.MaxPowerOutput end)
        if ok and m then maxKW = maxKW + m; table.insert(maxEach, string.format("%.1f", m)) end
    end
    local subName = (Submarine.MainSub and Submarine.MainSub.Info and Submarine.MainSub.Info.Name) or "unknown"
    local safe = tostring(subName):gsub("[^%w_%-]", "_")
    local dir = logDir()
    local n = 1
    while File.Exists(string.format("%s/%s_round%03d.csv", dir, safe, n)) do n = n + 1 end
    filePath = string.format("%s/%s_round%03d.csv", dir, safe, n)
    local rods, fuelType = 0, "uranium"
    local types = { fuelrod = "uranium", thoriumfuelrod = "thorium", fulguriumfuelrod = "fulgurium", fulguriumfuelrodvolatile = "volatile" }
    pcall(function()
        for rod in dev.reactors[1].Item.OwnInventory.AllItems do
            rods = rods + 1
            local t = types[tostring(rod.Prefab.Identifier)]
            if t then fuelType = t end
        end
    end)
    local battCap, battN, battMax, battOut, capsN, capsCap = 0, 0, 0, 0, 0, 0
    for _, pc in ipairs(dev.batteries) do pcall(function() battCap = battCap + pc.Capacity; battMax = battMax + pc.MaxRechargeSpeed; battOut = battOut + pc.MaxOutPut; battN = battN + 1 end) end
    for _, pc in ipairs(dev.supercaps) do pcall(function() capsCap = capsCap + pc.Capacity; capsN = capsN + 1 end) end
    local engMax, pumpMax = 0, 0
    for _, e in ipairs(dev.engines) do pcall(function() engMax = engMax + e.PowerConsumption end) end
    for _, p in ipairs(dev.pumps) do pcall(function() pumpMax = pumpMax + p.PowerConsumption end) end
    local ri = dev.reactors[1].Item
    local rate = 0.2
    pcall(function() rate = dev.reactors[1].FuelConsumptionRate end)
    header = "# BaroPowerLog v3\n"
        .. "# sub=" .. tostring(subName) .. "\n"
        .. (maxKW > 0 and ("# reactor_max_kw=" .. string.format("%.1f", maxKW) .. "\n") or "")
        .. "# reactors=" .. #dev.reactors .. " (" .. table.concat(maxEach, "+") .. ")\n"
        .. "# fuel_rods=" .. rods .. "\n"
        .. "# fuel_type=" .. fuelType .. "\n"
        .. "# fuel_consumption_rate=" .. string.format("%.3f", rate) .. "\n"
        .. "# ship_batteries=" .. battN .. " (capacity " .. string.format("%.0f", battCap) .. " kW*min, max recharge " .. string.format("%.0f", battMax) .. " kW, max output " .. string.format("%.0f", battOut) .. " kW)\n"
        .. "# supercapacitors=" .. capsN .. " (capacity " .. string.format("%.0f", capsCap) .. " kW*min)\n"
        .. "# engines=" .. #dev.engines .. " (max " .. string.format("%.0f", engMax) .. " kW) pumps=" .. #dev.pumps .. " (max " .. string.format("%.0f", pumpMax) .. " kW) turrets=" .. #dev.turrets .. " sonars=" .. #dev.sonars .. " junction_boxes=" .. #dev.junctions .. "\n"
        .. "# reactor_signal_wires=fission:" .. wired(ri, "set_fissionrate") .. " turbine:" .. wired(ri, "set_turbineoutput") .. " (0 = run by hand/AutoTemp)\n"
        .. gameInfo()
        .. "t," .. table.concat(COLS, ",") .. "\n"
    rows, roundTime, lastReal, lastRowT, last = {}, 0, Timer.GetTime(), -1e9, nil
    nextFlush, nextScan, nextSlow, nextSit = PL.flushInterval, PL.rescanInterval, 0, 0
    slow, sit, maxEst, pendingEvents = {}, {}, {}, {}
    active = true
    log("recording " .. tostring(subName) .. " (max " .. string.format("%.0f", maxKW) .. " kW) -> " .. filePath)
end

local function stopRound()
    if not active then return end
    flush(true)
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
    if roundTime >= nextScan then nextScan = roundTime + PL.rescanInterval; scan() end
    if #dev.reactors == 0 then return end
    if roundTime >= nextSlow then nextSlow = roundTime + PL.slowInterval; pcall(sampleSlow) end
    if roundTime >= nextSit then nextSit = roundTime + PL.situationInterval; pcall(sampleSituation) end

    local ok, v = pcall(sample)
    if not ok then return end
    if last ~= nil then
        if v.rods ~= last.rods then event("rods " .. tostring(last.rods) .. "->" .. tostring(v.rods)) end
        if v.autotemp ~= last.autotemp then event(v.autotemp == 1 and "autotemp on" or "autotemp off") end
        if v.power_on ~= last.power_on then event(v.power_on == 1 and "reactor on" or "reactor off") end
        if (v.temp or 0) > 70 and (last.temp or 0) <= 70 then event("temp > 70") end
    end
    local gap = roundTime - lastRowT
    local big = last ~= nil and math.abs((v.demand or 0) - (last.demand or 0)) >= PL.bigJumpKW
    if #pendingEvents > 0 or gap >= PL.heartbeat or (changed(v) and (gap >= PL.minRowGap or big)) then
        v.event = table.concat(pendingEvents, "; "); pendingEvents = {}
        local cells = { string.format("%.3f", roundTime) }
        for _, c in ipairs(COLS) do table.insert(cells, fmt(c, v[c])) end
        table.insert(rows, table.concat(cells, ","))
        last, lastRowT = v, roundTime
    end
    if roundTime >= nextFlush then nextFlush = roundTime + PL.flushInterval; flush(false) end
end)

-- started mid-round (e.g. "reloadlua")
if Game.RoundStarted then startRound() end
