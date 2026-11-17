import { useState, useEffect, useCallback } from 'react';
import { fw } from '../lib/firmware/grblCommands.js';

export function useMotionManager(payloadStatus, isEmergencyStopped) {
  // Speeds are mm/s. At job time they are ×60 → mm/min, then clamped to SAFE_FEEDS (300 mm/min).
  // Keep profiles ≤ 5 mm/s so Rapid never asks for more than GRBL Y max ($111=300).
  const MAX_SPEED_MMS = 5;
  
  const defaultProfiles = {
    Rapid: { speed: 5, accel: 80, decel: 80 },
    Soldering: { speed: 4, accel: 50, decel: 50 },
    Calibration: { speed: 3, accel: 40, decel: 40 },
    Homing: { speed: 3, accel: 50, decel: 50 }
  };

  const [profiles, setProfiles] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('motionProfiles'));
      if (stored) return { ...defaultProfiles, ...stored };
    } catch {
      // fallback
    }
    return defaultProfiles;
  });

  const [activeProfileName, setActiveProfileName] = useState('Rapid');
  
  // Safe state computation
  const isSafeToMoveFast = !isEmergencyStopped && payloadStatus !== 'OVER_LIMIT';
  const restrictionReason = isEmergencyStopped ? 'Emergency Stop Active' :
                            payloadStatus === 'OVER_LIMIT' ? 'Payload exceeds safe limits' : null;

  useEffect(() => {
    localStorage.setItem('motionProfiles', JSON.stringify(profiles));
  }, [profiles]);

  const updateProfile = useCallback((name, updates) => {
    setProfiles(prev => {
      const current = prev[name];
      const nextSpeed = Math.min(MAX_SPEED_MMS, Math.max(0, updates.speed !== undefined ? updates.speed : current.speed));
      return {
        ...prev,
        [name]: { ...current, ...updates, speed: nextSpeed }
      };
    });
  }, []);

  const getActiveSettings = useCallback(() => {
    let settings = profiles[activeProfileName];
    if (!isSafeToMoveFast) {
      settings = { ...settings, speed: Math.min(settings.speed, 20) };
    }
    return settings;
  }, [profiles, activeProfileName, isSafeToMoveFast]);

  const applyProfileToMachine = useCallback(async (profileName) => {
    setActiveProfileName(profileName);
    console.log('[MotionManager] Switched active profile to: ' + profileName);
  }, []);

  return {
    profiles,
    activeProfileName,
    updateProfile,
    applyProfileToMachine,
    getActiveSettings,
    maxSpeedMmS: MAX_SPEED_MMS,
    isSafeToMoveFast,
    restrictionReason
  };
}

