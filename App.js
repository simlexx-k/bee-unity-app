import 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import * as AuthSession from 'expo-auth-session';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, Marker, Polygon } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

WebBrowser.maybeCompleteAuthSession();

const DEFAULT_AUTH_ISSUER = 'https://auth.localtest.me';
const AUTH_ISSUER = process.env.EXPO_PUBLIC_AUTH_ISSUER || DEFAULT_AUTH_ISSUER;
const OIDC_CLIENT_ID = 'beeunity-mobile';
const DEFAULT_SIGNUP_URL = 'https://signup.localtest.me/signup';
const DEFAULT_API_BASE_URL = 'https://api.localtest.me';
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL;
const SESSION_KEY = 'beeunity_session';
const REFRESH_BUFFER_SECONDS = 90;
const HEADING_FONT = Platform.select({ ios: 'Georgia', android: 'serif' });
const BODY_FONT = Platform.select({ ios: 'Avenir Next', android: 'sans-serif-medium' });
const NOTIFICATION_CHANNEL_ID = 'beeunity-alerts';
const HEADER_HEIGHT = 72;
const Tab = createBottomTabNavigator();
const DashboardStack = createStackNavigator();
const HivesStack = createStackNavigator();
const MapStack = createStackNavigator();
const AlertsStack = createStackNavigator();
const ProfileStack = createStackNavigator();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const buildDisplayName = (profile) => {
  if (!profile) {
    return '';
  }
  if (profile.name) {
    return profile.name;
  }
  const givenName = profile.given_name || profile.givenName || '';
  const familyName = profile.family_name || profile.familyName || '';
  const combined = `${givenName} ${familyName}`.trim();
  if (combined) {
    return combined;
  }
  return profile.preferred_username || profile.preferredUsername || profile.email || '';
};

const buildGreeting = (date) => {
  const hour = date.getHours();
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 17) {
    return 'Good afternoon';
  }
  if (hour < 21) {
    return 'Good evening';
  }
  return 'Good night';
};

const trimNameToLast = (value) => {
  if (!value) {
    return '';
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.includes('@')) {
    const handle = trimmed.split('@')[0];
    const parts = handle.split(/[._-]+/).filter(Boolean);
    return parts[parts.length - 1] || handle;
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
};

const buildHiveForm = (profile, wards, seed = {}) => {
  const defaultWardId = seed.ward_id || profile?.ward_id || wards?.[0]?.id || '';
  return {
    name: seed.name || '',
    ward_id: defaultWardId,
    latitude: seed.latitude ?? null,
    longitude: seed.longitude ?? null,
    hive_type: seed.hive_type || '',
    hive_capacity: seed.hive_capacity ? String(seed.hive_capacity) : '',
    has_sensor: Boolean(seed.has_sensor),
    sensor_id: seed.sensor_id || '',
    notes: seed.notes || '',
  };
};

const resolveRedirectUri = () => {
  const envRedirect = process.env.EXPO_PUBLIC_OIDC_REDIRECT_URI;
  if (envRedirect) {
    return envRedirect;
  }

  return AuthSession.makeRedirectUri({
    scheme: 'beeunity',
    path: 'oauth/callback',
    useProxy: __DEV__,
  });
};

const resolveSignupUrl = () => {
  const envHost = process.env.EXPO_PUBLIC_SIGNUP_HOST;
  if (envHost) {
    return envHost.startsWith('http')
      ? envHost
      : `http://${envHost.replace(/\/$/, '')}/signup`;
  }

  if (!__DEV__) {
    return DEFAULT_SIGNUP_URL;
  }

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.manifest?.hostUri;
  if (!hostUri) {
    return DEFAULT_SIGNUP_URL;
  }

  const host = hostUri.split(':')[0];
  return `http://${host}/signup`;
};

const SIGNUP_URL = resolveSignupUrl();

const base64UrlDecode = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  const paddedValue = `${padded}${'='.repeat(padLength)}`;

  if (typeof globalThis?.atob === 'function') {
    return globalThis.atob(paddedValue);
  }

  try {
    const { Buffer } = require('buffer');
    return Buffer.from(paddedValue, 'base64').toString('utf8');
  } catch (error) {
    return '';
  }
};

const decodeJwtPayload = (token) => {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const decoded = base64UrlDecode(parts[1]);
    return decoded ? JSON.parse(decoded) : null;
  } catch (error) {
    return null;
  }
};

const isSessionExpired = (session) => {
  if (!session?.expiresAt) {
    return false;
  }

  return Math.floor(Date.now() / 1000) >= session.expiresAt;
};

const REQUIRED_PROFILE_FIELDS = [
  'full_name',
  'phone_number',
  'ward_id',
  'hive_count',
  'beekeeping_years',
  'hive_type',
  'farm_size_acres',
  'primary_goal',
];

const isProfileComplete = (profile) => {
  if (!profile) {
    return false;
  }

  return REQUIRED_PROFILE_FIELDS.every((key) => {
    const value = profile[key];
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }
    return true;
  });
};

const useWardClimateBoundary = (wardId, apiBaseUrl, authHeaders) => {
  const [climateStatus, setClimateStatus] = useState('idle');
  const [climateSnapshot, setClimateSnapshot] = useState(null);
  const [boundaryStatus, setBoundaryStatus] = useState('idle');
  const [wardBoundary, setWardBoundary] = useState([]);

  useEffect(() => {
    if (!wardId || !apiBaseUrl) {
      return;
    }
    let active = true;
    const loadClimate = async () => {
      setClimateStatus('loading');
      try {
        const res = await fetch(
          `${apiBaseUrl}/climate/daily?limit=1&ward_id=${encodeURIComponent(wardId)}`,
          {
            headers: { ...authHeaders },
          }
        );
        if (!res.ok) {
          if (active) {
            setClimateStatus('error');
          }
          return;
        }
        const data = await res.json();
        if (!active) {
          return;
        }
        const record = Array.isArray(data?.records) ? data.records[0] : null;
        setClimateSnapshot(record || null);
        setClimateStatus(record ? 'ready' : 'empty');
      } catch (error) {
        if (active) {
          setClimateStatus('error');
        }
      }
    };

    loadClimate();
    return () => {
      active = false;
    };
  }, [wardId, apiBaseUrl, authHeaders]);

  useEffect(() => {
    if (!wardId || !apiBaseUrl) {
      return;
    }
    let active = true;
    const loadBoundary = async () => {
      setBoundaryStatus('loading');
      try {
        const res = await fetch(
          `${apiBaseUrl}/locations/wards/boundary?ward_id=${encodeURIComponent(wardId)}`,
          {
            headers: { ...authHeaders },
          }
        );
        if (!res.ok) {
          if (active) {
            setBoundaryStatus('error');
          }
          return;
        }
        const data = await res.json();
        if (!active) {
          return;
        }
        const polygons = Array.isArray(data?.polygons) ? data.polygons : [];
        setWardBoundary(polygons);
        setBoundaryStatus(polygons.length ? 'ready' : 'empty');
      } catch (error) {
        if (active) {
          setBoundaryStatus('error');
        }
      }
    };

    loadBoundary();
    return () => {
      active = false;
    };
  }, [wardId, apiBaseUrl, authHeaders]);

  return { climateStatus, climateSnapshot, boundaryStatus, wardBoundary };
};

const DashboardScreen = ({
  onSignOut,
  onManageHives,
  user,
  profile,
  wards,
  apiBaseUrl,
  authHeaders,
}) => {
  const reveal = useState(() => new Animated.Value(0))[0];
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    Animated.timing(reveal, {
      toValue: 1,
      duration: 650,
      useNativeDriver: true,
    }).start();
  }, [reveal]);

  useEffect(() => {
    let intervalId;
    const tick = () => setNow(new Date());
    const nowTime = new Date();
    const delay =
      (60 - nowTime.getSeconds()) * 1000 - nowTime.getMilliseconds();
    const timeoutId = setTimeout(() => {
      tick();
      intervalId = setInterval(tick, 60000);
    }, Math.max(delay, 0));
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, []);

  const animatedStyle = {
    opacity: reveal,
    transform: [
      {
        translateY: reveal.interpolate({
          inputRange: [0, 1],
          outputRange: [18, 0],
        }),
      },
    ],
  };

  const highlightMetrics = [
    { label: 'Queen presence', value: '82%', note: 'High confidence' },
    { label: 'Hive occupancy', value: '74%', note: 'Moderate' },
    { label: 'Yield outlook', value: '1.6 kg/day', note: 'Next 14 days' },
    { label: 'Forage index', value: '0.46 NDVI', note: 'Stable' },
  ];

  const climatePulse = [
    { label: 'Rain (14d)', value: '49.5 mm' },
    { label: 'Avg temp', value: '21.1°C' },
    { label: 'Humidity', value: '70%' },
  ];

  const priorityAlerts = [
    {
      title: 'Forage pressure',
      detail: 'NDVI trending lower across the ward.',
      action: 'Plan supplemental feeding over the next 7 days.',
      severity: 'watch',
    },
    {
      title: 'Humidity risk',
      detail: 'High humidity after recent rains.',
      action: 'Ventilate hives to prevent mold.',
      severity: 'medium',
    },
  ];

  const quickActions = [
    { title: 'Queen check window', detail: 'Best window: tomorrow 7–9am.' },
    { title: 'Harvest planning', detail: 'Model suggests +18% yield in 14 days.' },
  ];

  const alertPalette = {
    high: '#F57C73',
    medium: '#E2B25B',
    watch: '#7ED9B6',
    low: '#6DBFE8',
  };

  const sparkHeights = [14, 22, 10, 18, 26, 16, 24, 12];
  const displayName = trimNameToLast(
    profile?.full_name || user?.name || user?.preferred_username || user?.email || 'keeper'
  );
  const greeting = buildGreeting(now);
  const greetingDay = now.toLocaleDateString(undefined, { weekday: 'long' });
  const greetingTime = now.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const wardName = profile?.ward_name || profile?.ward?.name || 'Emali Mulala';
  const wardSubcounty = profile?.ward_subcounty || profile?.ward?.subcounty || 'Makueni County';
  const hiveCountLabel = profile?.hive_count ? `${profile.hive_count} hives` : 'Hive count pending';
  const wardId = profile?.ward_id || profile?.ward?.id;
  const ward = useMemo(() => {
    if (!wardId || !Array.isArray(wards)) {
      return profile?.ward || null;
    }
    return wards.find((item) => item.id === wardId) || profile?.ward || null;
  }, [wardId, wards, profile]);
  const { climateStatus, climateSnapshot, boundaryStatus, wardBoundary } = useWardClimateBoundary(
    wardId,
    apiBaseUrl,
    authHeaders
  );
  const [hives, setHives] = useState([]);
  const [hiveStatus, setHiveStatus] = useState('idle');

  const wardLatitude = ward?.latitude ?? -1.7833;
  const wardLongitude = ward?.longitude ?? 37.6283;
  const mapRegion = useMemo(
    () => ({
      latitude: wardLatitude,
      longitude: wardLongitude,
      latitudeDelta: 0.18,
      longitudeDelta: 0.18,
    }),
    [wardLatitude, wardLongitude]
  );

  const ndviValue = climateSnapshot?.ndvi_mean ?? null;
  const ndviDisplay = ndviValue === null || ndviValue === undefined ? '—' : ndviValue.toFixed(2);
  const tempDisplay =
    climateSnapshot?.temp_mean === null || climateSnapshot?.temp_mean === undefined
      ? '—'
      : `${climateSnapshot.temp_mean.toFixed(1)}°C`;
  const rainDisplay =
    climateSnapshot?.rainfall_mm === null || climateSnapshot?.rainfall_mm === undefined
      ? '—'
      : `${climateSnapshot.rainfall_mm.toFixed(1)} mm`;
  const snapshotDate = climateSnapshot?.date
    ? new Date(climateSnapshot.date).toLocaleDateString()
    : 'Latest reading';

  const ndviColor =
    ndviValue === null
      ? 'rgba(126, 217, 182, 0.2)'
      : ndviValue >= 0.55
        ? 'rgba(126, 217, 182, 0.4)'
        : ndviValue >= 0.4
          ? 'rgba(226, 178, 91, 0.35)'
          : 'rgba(245, 124, 115, 0.35)';
  const ndviRing = ndviValue === null ? 'rgba(126, 217, 182, 0.16)' : ndviColor;
  const humidityDisplay =
    climateSnapshot?.humidity_mean === null || climateSnapshot?.humidity_mean === undefined
      ? '—'
      : `${climateSnapshot.humidity_mean.toFixed(0)}%`;

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <View style={styles.dashboardCanvas}>
        <View style={styles.glowTop} />
        <View style={styles.glowBottom} />
        <Animated.ScrollView
          contentContainerStyle={styles.dashboardContent}
          showsVerticalScrollIndicator={false}
          style={animatedStyle}
          stickyHeaderIndices={[0]}
        >
          <View style={styles.stickyHeader}>
            <View style={styles.headerSlot}>
              <View>
                <Text style={styles.headerSlotTitle}>BeeUnity</Text>
                <View style={styles.headerSlotMetaRow}>
                  <View style={styles.headerSlotDot} />
                  <Text style={styles.headerSlotMeta}>
                    {wardName} · {wardSubcounty}
                  </Text>
                </View>
              </View>
              <Pressable style={styles.headerSlotAction} onPress={onSignOut}>
                <Text style={styles.headerSlotActionText}>Sign out</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.dashboardBody}>
            <View style={styles.dashboardHeader}>
              <View>
                <Text style={styles.dashboardEyebrow}>Ward overview</Text>
                <Text style={styles.dashboardTitle}>
                  {greeting}, {displayName}
                </Text>
                <Text style={styles.dashboardSubtitle}>
                  {greetingDay} · {greetingTime} in {wardName}
                </Text>
                <Text style={styles.dashboardMeta}>
                  Occupancy, queen presence, and yield insights for today.
                </Text>
              </View>
            </View>

            <View style={styles.wardCard}>
              <View style={styles.wardHeader}>
                <View>
                  <Text style={styles.wardLabel}>Ward focus</Text>
                  <Text style={styles.wardName}>{wardName}</Text>
                </View>
                <Pressable style={styles.wardAction}>
                  <Text style={styles.wardActionText}>Change ward</Text>
                </Pressable>
              </View>
              <View style={styles.wardChips}>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>NDVI 0.46</Text>
                </View>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>Rain alert: low</Text>
                </View>
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{hiveCountLabel}</Text>
                </View>
              </View>
              <Pressable style={styles.hiveAction} onPress={onManageHives}>
                <Text style={styles.hiveActionText}>Manage hives</Text>
              </Pressable>
            </View>

            <View style={styles.mapCard}>
              <View style={styles.mapHeader}>
                <View>
                  <Text style={styles.mapTitle}>Weather + NDVI map view</Text>
                  <Text style={styles.mapSubtitle}>
                    {wardName} · {snapshotDate}
                  </Text>
                </View>
                <View style={styles.mapBadge}>
                  <Text style={styles.mapBadgeText}>
                    {boundaryStatus === 'loading' || climateStatus === 'loading'
                      ? 'LOADING'
                      : 'WARD MAP'}
                  </Text>
                </View>
              </View>
              <View style={styles.mapViewWrap}>
                <MapView style={styles.mapView} initialRegion={mapRegion}>
                  {wardBoundary.map((polygon, index) => (
                    <Polygon
                      key={`boundary-${index}`}
                      coordinates={polygon}
                      strokeColor="rgba(109, 191, 232, 0.85)"
                      fillColor={ndviColor}
                      strokeWidth={2}
                    />
                  ))}
                  <Circle
                    center={{ latitude: wardLatitude, longitude: wardLongitude }}
                    radius={5200}
                    strokeColor="rgba(255,255,255,0.18)"
                    fillColor={ndviRing}
                  />
                  <Circle
                    center={{ latitude: wardLatitude, longitude: wardLongitude }}
                    radius={3200}
                    strokeColor="rgba(255,255,255,0.12)"
                    fillColor={ndviRing}
                  />
                  <Marker
                    coordinate={{ latitude: wardLatitude, longitude: wardLongitude }}
                    title={wardName}
                    description={wardSubcounty}
                  />
                </MapView>
                <View style={styles.mapLegendRow}>
                  <View style={styles.mapLegendChip}>
                    <View style={[styles.mapLegendDot, { backgroundColor: '#6DBFE8' }]} />
                    <View>
                      <Text style={styles.mapLegendLabel}>Rain</Text>
                      <Text style={styles.mapLegendValue}>{rainDisplay}</Text>
                    </View>
                  </View>
                  <View style={styles.mapLegendChip}>
                    <View style={[styles.mapLegendDot, { backgroundColor: '#E2B25B' }]} />
                    <View>
                      <Text style={styles.mapLegendLabel}>Avg temp</Text>
                      <Text style={styles.mapLegendValue}>{tempDisplay}</Text>
                    </View>
                  </View>
                  <View style={styles.mapLegendChip}>
                    <View style={[styles.mapLegendDot, { backgroundColor: '#7ED9B6' }]} />
                    <View>
                      <Text style={styles.mapLegendLabel}>Humidity</Text>
                      <Text style={styles.mapLegendValue}>{humidityDisplay}</Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>

            <View style={styles.metricsGrid}>
              {highlightMetrics.map((metric) => (
                <View key={metric.label} style={styles.metricCard}>
                  <Text style={styles.metricValue}>{metric.value}</Text>
                  <Text style={styles.metricLabel}>{metric.label}</Text>
                  <Text style={styles.metricNote}>{metric.note}</Text>
                </View>
              ))}
            </View>

            <View style={styles.pulseCard}>
              <View style={styles.pulseHeader}>
                <View>
                  <Text style={styles.pulseTitle}>Ward climate pulse</Text>
                  <Text style={styles.pulseSubtitle}>
                    Weather + NDVI context for occupancy, stress, and yield.
                  </Text>
                </View>
                <View style={styles.pulseBadge}>
                  <Text style={styles.pulseBadgeText}>LIVE</Text>
                </View>
              </View>
              <View style={styles.pulseRow}>
                {climatePulse.map((item) => (
                  <View key={item.label} style={styles.pulseStat}>
                    <Text style={styles.pulseValue}>{item.value}</Text>
                    <Text style={styles.pulseLabel}>{item.label}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.pulseActions}>
                {quickActions.map((action) => (
                  <View key={action.title} style={styles.pulseAction}>
                    <Text style={styles.pulseActionTitle}>{action.title}</Text>
                    <Text style={styles.pulseActionDetail}>{action.detail}</Text>
                  </View>
                ))}
              </View>
            </View>

            <View style={styles.yieldCard}>
              <View style={styles.yieldHeader}>
                <Text style={styles.yieldTitle}>Honey yield outlook</Text>
                <Text style={styles.yieldSubtitle}>Climate-driven production forecast</Text>
              </View>
              <View style={styles.yieldBody}>
                <View>
                  <Text style={styles.yieldValue}>+18%</Text>
                  <Text style={styles.yieldLabel}>Improvement vs last month</Text>
                </View>
                <View style={styles.sparkline}>
                  {sparkHeights.map((height, index) => (
                    <View
                      key={`${height}-${index}`}
                      style={[styles.sparkBar, { height }]}
                    />
                  ))}
                </View>
              </View>
              <View style={styles.yieldActionRow}>
                <Pressable style={styles.primaryAction}>
                  <Text style={styles.primaryActionText}>Request full forecast</Text>
                </Pressable>
                <Pressable style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>Share report</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Animated.ScrollView>
      </View>
    </SafeAreaView>
  );
};

const MapScreen = ({ profile, wards, apiBaseUrl, authHeaders, navigation }) => {
  const wardName = profile?.ward_name || profile?.ward?.name || 'Emali Mulala';
  const wardSubcounty = profile?.ward_subcounty || profile?.ward?.subcounty || 'Makueni County';
  const wardId = profile?.ward_id || profile?.ward?.id;
  const [hives, setHives] = useState([]);
  const [hiveStatus, setHiveStatus] = useState('idle');
  const [selectedHive, setSelectedHive] = useState(null);
  const ward = useMemo(() => {
    if (!wardId || !Array.isArray(wards)) {
      return profile?.ward || null;
    }
    return wards.find((item) => item.id === wardId) || profile?.ward || null;
  }, [wardId, wards, profile]);
  const { climateStatus, climateSnapshot, boundaryStatus, wardBoundary } = useWardClimateBoundary(
    wardId,
    apiBaseUrl,
    authHeaders
  );
  const wardLatitude = ward?.latitude ?? -1.7833;
  const wardLongitude = ward?.longitude ?? 37.6283;
  const mapRegion = useMemo(
    () => ({
      latitude: wardLatitude,
      longitude: wardLongitude,
      latitudeDelta: 0.18,
      longitudeDelta: 0.18,
    }),
    [wardLatitude, wardLongitude]
  );

  const ndviValue = climateSnapshot?.ndvi_mean ?? null;
  const ndviDisplay = ndviValue === null || ndviValue === undefined ? '—' : ndviValue.toFixed(2);
  const tempDisplay =
    climateSnapshot?.temp_mean === null || climateSnapshot?.temp_mean === undefined
      ? '—'
      : `${climateSnapshot.temp_mean.toFixed(1)}°C`;
  const rainDisplay =
    climateSnapshot?.rainfall_mm === null || climateSnapshot?.rainfall_mm === undefined
      ? '—'
      : `${climateSnapshot.rainfall_mm.toFixed(1)} mm`;
  const humidityDisplay =
    climateSnapshot?.humidity_mean === null || climateSnapshot?.humidity_mean === undefined
      ? '—'
      : `${climateSnapshot.humidity_mean.toFixed(0)}%`;
  const snapshotDate = climateSnapshot?.date
    ? new Date(climateSnapshot.date).toLocaleDateString()
    : 'Latest reading';

  const ndviColor =
    ndviValue === null
      ? 'rgba(126, 217, 182, 0.2)'
      : ndviValue >= 0.55
        ? 'rgba(126, 217, 182, 0.4)'
        : ndviValue >= 0.4
          ? 'rgba(226, 178, 91, 0.35)'
          : 'rgba(245, 124, 115, 0.35)';

  useEffect(() => {
    if (!apiBaseUrl) {
      return;
    }
    let active = true;
    const loadHives = async () => {
      setHiveStatus('loading');
      try {
        const res = await fetch(`${apiBaseUrl}/hives`, {
          headers: { ...authHeaders },
        });
        if (!res.ok) {
          if (active) {
            setHiveStatus('error');
          }
          return;
        }
        const data = await res.json();
        if (!active) {
          return;
        }
        const list = Array.isArray(data) ? data : [];
        setHives(list);
        setHiveStatus('ready');
      } catch (error) {
        if (active) {
          setHiveStatus('error');
        }
      }
    };

    loadHives();
    return () => {
      active = false;
    };
  }, [apiBaseUrl, authHeaders]);

  const closeHiveModal = () => setSelectedHive(null);
  const selectedHiveCoords =
    selectedHive?.latitude && selectedHive?.longitude
      ? `${selectedHive.latitude.toFixed(4)}, ${selectedHive.longitude.toFixed(4)}`
      : 'No coordinates';
  const openHiveDetails = () => {
    if (!selectedHive) {
      return;
    }
    closeHiveModal();
    if (navigation?.navigate) {
      navigation.navigate('Hives', {
        screen: 'HivesHome',
        params: { openHiveId: selectedHive.id },
      });
    }
  };

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <View style={styles.mapScreen}>
        <MapView style={styles.mapFullView} initialRegion={mapRegion}>
          {wardBoundary.map((polygon, index) => (
            <Polygon
              key={`map-boundary-${index}`}
              coordinates={polygon}
              strokeColor="rgba(109, 191, 232, 0.85)"
              fillColor={ndviColor}
              strokeWidth={2}
            />
          ))}
          {hives
            .filter(
              (hive) =>
                hive?.latitude !== null &&
                hive?.latitude !== undefined &&
                hive?.longitude !== null &&
                hive?.longitude !== undefined
            )
            .map((hive) => (
              <Marker
                key={`hive-${hive.id}`}
                coordinate={{
                  latitude: hive.latitude,
                  longitude: hive.longitude,
                }}
                title={hive.name}
                description={hive.ward_name || wardName}
                pinColor="#E2B25B"
                onPress={() => setSelectedHive(hive)}
              />
            ))}
          <Circle
            center={{ latitude: wardLatitude, longitude: wardLongitude }}
            radius={5200}
            strokeColor="rgba(255,255,255,0.18)"
            fillColor="transparent"
          />
        </MapView>
        <View style={styles.mapOverlayTop} pointerEvents="box-none">
          <View style={styles.stickyHeader}>
            <View style={styles.headerSlot}>
              <View>
                <Text style={styles.headerSlotTitle}>Ward map</Text>
                <Text style={styles.headerSlotMeta}>
                  {wardName} · {wardSubcounty}
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.mapOverlayCard}>
            <View style={styles.mapHeader}>
              <View>
                <Text style={styles.mapTitle}>Weather + NDVI context</Text>
                <Text style={styles.mapSubtitle}>
                  {wardName} · {snapshotDate}
                </Text>
              </View>
              <View style={styles.mapBadge}>
                <Text style={styles.mapBadgeText}>
                  {boundaryStatus === 'loading' || climateStatus === 'loading'
                    ? 'LOADING'
                    : 'WARD MAP'}
                </Text>
              </View>
            </View>
          </View>
        </View>
        <View style={styles.mapOverlayBottom} pointerEvents="box-none">
          <View style={[styles.wardChips, styles.mapOverlayChips]}>
            <View style={styles.chip}>
              <Text style={styles.chipText}>
                {hiveStatus === 'loading'
                  ? 'Hives loading...'
                  : `${hives.length} hives`}
              </Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>NDVI {ndviDisplay}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>Rain {rainDisplay}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>Humidity {humidityDisplay}</Text>
            </View>
            <View style={styles.chip}>
              <Text style={styles.chipText}>Avg temp {tempDisplay}</Text>
            </View>
          </View>
        </View>
      </View>
      <Modal
        visible={!!selectedHive}
        transparent
        animationType="fade"
        onRequestClose={closeHiveModal}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeHiveModal} />
          <View style={styles.hiveModalCard}>
            <View style={styles.hiveModalHeader}>
              <View>
                <Text style={styles.hiveModalTitle}>{selectedHive?.name || 'Hive'}</Text>
                <Text style={styles.hiveModalSubtitle}>
                  {selectedHive?.ward_name || wardName} ·{' '}
                  {selectedHive?.hive_type || 'Hive type'}
                </Text>
              </View>
              <Pressable style={styles.modalClose} onPress={closeHiveModal}>
                <Ionicons name="close" size={18} color="#E7E3D4" />
              </Pressable>
            </View>
            <View style={styles.hiveModalGrid}>
              <View style={styles.hiveModalItem}>
                <Text style={styles.hiveModalLabel}>Coordinates</Text>
                <Text style={styles.hiveModalValue}>{selectedHiveCoords}</Text>
              </View>
              <View style={styles.hiveModalItem}>
                <Text style={styles.hiveModalLabel}>Capacity</Text>
                <Text style={styles.hiveModalValue}>
                  {selectedHive?.hive_capacity || '—'}
                </Text>
              </View>
              <View style={styles.hiveModalItem}>
                <Text style={styles.hiveModalLabel}>Sensor</Text>
                <Text style={styles.hiveModalValue}>
                  {selectedHive?.has_sensor ? 'Yes' : 'No'}
                </Text>
              </View>
            </View>
            <Pressable style={styles.primaryAction} onPress={openHiveDetails}>
              <Text style={styles.primaryActionText}>Open hive details</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

const AlertsScreen = ({ profile }) => {
  const wardName = profile?.ward_name || profile?.ward?.name || 'Makueni County';
  const alerts = [
    {
      title: 'Forage pressure',
      detail: 'NDVI trending lower across the ward.',
      action: 'Plan supplemental feeding over the next 7 days.',
      severity: 'watch',
    },
    {
      title: 'Humidity risk',
      detail: 'High humidity after recent rains.',
      action: 'Ventilate hives to prevent mold.',
      severity: 'medium',
    },
  ];

  const alertPalette = {
    high: '#F57C73',
    medium: '#E2B25B',
    watch: '#7ED9B6',
    low: '#6DBFE8',
  };

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.alertsContent}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.stickyHeader}>
          <View style={styles.headerSlot}>
            <View>
              <Text style={styles.headerSlotTitle}>Alerts</Text>
              <Text style={styles.headerSlotMeta}>{wardName}</Text>
            </View>
          </View>
        </View>
        <View style={styles.alertsBody}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Active alerts</Text>
            <Text style={styles.sectionSubtitle}>Stay ahead of ward risks.</Text>
          </View>
          <View style={styles.alertList}>
            {alerts.map((alert) => (
              <View key={alert.title} style={styles.alertItem}>
                <View
                  style={[
                    styles.alertDot,
                    { backgroundColor: alertPalette[alert.severity] || '#7ED9B6' },
                  ]}
                />
                <View style={styles.alertBody}>
                  <Text style={styles.alertTitle}>{alert.title}</Text>
                  <Text style={styles.alertDetail}>{alert.detail}</Text>
                  <Text style={styles.alertAction}>{alert.action}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const ProfileScreen = ({ user, profile, onSignOut, onEditProfile, apiBaseUrl, authHeaders }) => {
  const displayName =
    profile?.full_name || user?.name || user?.preferred_username || user?.email || 'BeeUnity user';
  const wardName = profile?.ward_name || profile?.ward?.name || 'Makueni County';
  const wardSubcounty = profile?.ward_subcounty || profile?.ward?.subcounty || 'Makueni County';
  const primaryGoal = profile?.primary_goal || 'Not set';
  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  const [hiveCount, setHiveCount] = useState(null);
  const [hiveCountStatus, setHiveCountStatus] = useState('idle');

  useEffect(() => {
    if (!apiBaseUrl) {
      return;
    }
    let active = true;
    const loadHiveCount = async () => {
      setHiveCountStatus('loading');
      try {
        const res = await fetch(`${apiBaseUrl}/hives`, {
          headers: { ...authHeaders },
        });
        if (!res.ok) {
          if (active) {
            setHiveCountStatus('error');
          }
          return;
        }
        const data = await res.json();
        if (!active) {
          return;
        }
        const list = Array.isArray(data) ? data : [];
        setHiveCount(list.length);
        setHiveCountStatus('ready');
      } catch (error) {
        if (active) {
          setHiveCountStatus('error');
        }
      }
    };
    loadHiveCount();
    return () => {
      active = false;
    };
  }, [apiBaseUrl, authHeaders]);

  const hiveCountDisplay =
    hiveCountStatus === 'ready' ? `${hiveCount}` : hiveCountStatus === 'loading' ? '...' : '—';

  const details = [
    { label: 'Full name', value: displayName },
    { label: 'Email', value: profile?.email || user?.email || 'Not set' },
    { label: 'Phone', value: profile?.phone_number || 'Not set' },
    { label: 'Ward', value: wardName },
    { label: 'Subcounty', value: wardSubcounty },
    {
      label: 'Hives tracked',
      value: hiveCountDisplay,
    },
    {
      label: 'Primary goal',
      value: primaryGoal,
    },
  ];
  const stats = [
    { label: 'Hives', value: hiveCountDisplay },
    {
      label: 'Years',
      value: profile?.beekeeping_years ? `${profile.beekeeping_years}` : '—',
    },
    { label: 'Sensors', value: profile?.has_sensors ? 'Yes' : 'No' },
  ];

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.profileContent}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.stickyHeader}>
          <View style={styles.headerSlot}>
            <View>
              <Text style={styles.headerSlotTitle}>Profile</Text>
              <Text style={styles.headerSlotMeta}>BeeUnity account</Text>
            </View>
          </View>
        </View>
        <View style={styles.profileBody}>
          <View style={styles.profileHero}>
            <View style={styles.profileHeroTop}>
              <View style={styles.profileAvatar}>
                <Text style={styles.profileAvatarText}>{initials || 'BU'}</Text>
              </View>
              <View style={styles.profileHeroMeta}>
                <Text style={styles.profileHeroName}>{displayName}</Text>
                <Text style={styles.profileHeroEmail}>
                  {profile?.email || user?.email || 'Email not set'}
                </Text>
                <Text style={styles.profileHeroWard}>
                  {wardName} · {wardSubcounty}
                </Text>
              </View>
            </View>
            <View style={styles.profileStatRow}>
              {stats.map((stat) => (
                <View key={stat.label} style={styles.profileStatCard}>
                  <Text style={styles.profileStatValue}>{stat.value}</Text>
                  <Text style={styles.profileStatLabel}>{stat.label}</Text>
                </View>
              ))}
            </View>
          </View>
          <View style={styles.profileCard}>
            <Text style={styles.sectionTitle}>Account details</Text>
            <Text style={styles.sectionSubtitle}>
              Keep your ward and apiary info up to date.
            </Text>
            <View style={styles.profileList}>
              {details.map((item) => (
                <View key={item.label} style={styles.profileRow}>
                  <Text style={styles.profileLabel}>{item.label}</Text>
                  <Text style={styles.profileValue}>{item.value}</Text>
                </View>
              ))}
            </View>
          </View>
          <Pressable style={[styles.secondaryAction, styles.profileEditButton]} onPress={onEditProfile}>
            <Text style={styles.secondaryActionText}>Edit profile</Text>
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={onSignOut}>
            <Text style={styles.primaryButtonText}>Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const HivesScreen = ({ onBack, apiBaseUrl, authHeaders, profile, wards, route, navigation }) => {
  const [hives, setHives] = useState([]);
  const [status, setStatus] = useState('idle');
  const [formMode, setFormMode] = useState('list');
  const [form, setForm] = useState(() => buildHiveForm(profile, wards));
  const [editingId, setEditingId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [locationStatus, setLocationStatus] = useState('idle');
  const [boundaryStatus, setBoundaryStatus] = useState('idle');
  const [wardBoundary, setWardBoundary] = useState([]);
  const [activeHive, setActiveHive] = useState(null);

  const wardOptions = useMemo(() => wards || [], [wards]);
  const selectedWard =
    wardOptions.find((item) => item.id === form.ward_id) ||
    profile?.ward ||
    wardOptions[0] ||
    null;
  const baseLatitude = form.latitude ?? selectedWard?.latitude ?? -1.7833;
  const baseLongitude = form.longitude ?? selectedWard?.longitude ?? 37.6283;
  const mapRegion = {
    latitude: baseLatitude,
    longitude: baseLongitude,
    latitudeDelta: 0.08,
    longitudeDelta: 0.08,
  };

  const parseOptionalInt = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : Math.round(parsed);
  };

  const loadHives = async () => {
    if (!apiBaseUrl) {
      return;
    }
    setStatus('loading');
    try {
      const res = await fetch(`${apiBaseUrl}/hives`, {
        headers: { ...authHeaders },
      });
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = await res.json();
      setHives(Array.isArray(data) ? data : []);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
    }
  };

  useEffect(() => {
    loadHives();
  }, [apiBaseUrl, authHeaders]);

  useEffect(() => {
    const openHiveId = route?.params?.openHiveId;
    if (!openHiveId || status !== 'ready') {
      return;
    }
    const targetHive = hives.find((hive) => hive.id === openHiveId);
    if (targetHive) {
      openHealth(targetHive);
      if (navigation?.setParams) {
        navigation.setParams({ openHiveId: undefined });
      }
    }
  }, [route?.params?.openHiveId, status, hives, navigation]);

  useEffect(() => {
    if (!form.ward_id) {
      setForm((prev) => ({ ...prev, ward_id: profile?.ward_id || wards?.[0]?.id || '' }));
    }
  }, [form.ward_id, profile, wards]);

  useEffect(() => {
    if (!form.ward_id || !apiBaseUrl) {
      return;
    }
    let active = true;
    const loadBoundary = async () => {
      setBoundaryStatus('loading');
      try {
        const res = await fetch(
          `${apiBaseUrl}/locations/wards/boundary?ward_id=${encodeURIComponent(form.ward_id)}`,
          {
            headers: { ...authHeaders },
          }
        );
        if (!res.ok) {
          if (active) {
            setBoundaryStatus('error');
          }
          return;
        }
        const data = await res.json();
        if (!active) {
          return;
        }
        const polygons = Array.isArray(data?.polygons) ? data.polygons : [];
        setWardBoundary(polygons);
        setBoundaryStatus(polygons.length ? 'ready' : 'empty');
      } catch (error) {
        if (active) {
          setBoundaryStatus('error');
        }
      }
    };

    loadBoundary();
    return () => {
      active = false;
    };
  }, [form.ward_id, apiBaseUrl, authHeaders]);

  const startNewHive = () => {
    setEditingId(null);
    setForm(buildHiveForm(profile, wards));
    setFormMode('form');
  };

  const startEditHive = (hive) => {
    setEditingId(hive.id);
    setForm(buildHiveForm(profile, wards, hive));
    setFormMode('form');
  };

  const openHealth = (hive) => {
    setActiveHive(hive);
    setFormMode('health');
  };

  const handleMapPress = (event) => {
    const { latitude, longitude } = event.nativeEvent.coordinate;
    setForm((prev) => ({
      ...prev,
      latitude,
      longitude,
    }));
  };

  const useWardCenter = () => {
    if (!selectedWard) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      latitude: selectedWard.latitude,
      longitude: selectedWard.longitude,
    }));
  };

  const useDeviceLocation = async () => {
    setLocationStatus('loading');
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== 'granted') {
      setLocationStatus('denied');
      Alert.alert('Location required', 'Enable location permissions to use GPS.');
      return;
    }
    try {
      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setForm((prev) => ({
        ...prev,
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      }));
      setLocationStatus('ready');
    } catch (error) {
      setLocationStatus('error');
      Alert.alert('Location failed', 'Unable to fetch GPS coordinates.');
    }
  };

  const saveHive = async () => {
    if (!form.name.trim()) {
      Alert.alert('Missing name', 'Add a hive name to continue.');
      return;
    }
    if (!form.ward_id) {
      Alert.alert('Missing ward', 'Select a ward for this hive.');
      return;
    }
    setIsSaving(true);
    const payload = {
      name: form.name.trim(),
      ward_id: form.ward_id,
      latitude: form.latitude,
      longitude: form.longitude,
      hive_type: form.hive_type.trim() || null,
      hive_capacity: parseOptionalInt(form.hive_capacity),
      has_sensor: Boolean(form.has_sensor),
      sensor_id: form.sensor_id.trim() || null,
      notes: form.notes.trim() || null,
    };
    try {
      const res = await fetch(
        `${apiBaseUrl}/hives${editingId ? `/${editingId}` : ''}`,
        {
          method: editingId ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(raw || 'Failed to save hive.');
      }
      await loadHives();
      setFormMode('list');
    } catch (error) {
      Alert.alert('Save failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteHive = async (hive) => {
    if (!apiBaseUrl) {
      return;
    }
    setIsDeleting(true);
    try {
      const res = await fetch(`${apiBaseUrl}/hives/${hive.id}`, {
        method: 'DELETE',
        headers: {
          ...authHeaders,
        },
      });
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(raw || 'Failed to delete hive.');
      }
      await loadHives();
    } catch (error) {
      Alert.alert('Delete failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmDelete = (hive) => {
    Alert.alert('Delete hive', `Remove ${hive.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteHive(hive) },
    ]);
  };
  const showBack = typeof onBack === 'function';

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.hivesContent}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.stickyHeader}>
          <View style={styles.headerSlot}>
            {showBack ? (
              <>
                <Pressable style={styles.headerSlotAction} onPress={onBack}>
                  <Text style={styles.headerSlotActionText}>Back</Text>
                </Pressable>
                <View style={styles.headerSlotCenter}>
                  <Text style={styles.headerSlotTitle}>Hive management</Text>
                  <Text style={styles.headerSlotMeta}>
                    {profile?.ward_name || 'Makueni County'}
                  </Text>
                </View>
              </>
            ) : (
              <View style={styles.headerSlotLeft}>
                <Text style={styles.headerSlotTitle}>Hive management</Text>
                <Text style={styles.headerSlotMeta}>
                  {profile?.ward_name || 'Makueni County'}
                </Text>
              </View>
            )}
            <Pressable style={styles.headerSlotAction} onPress={startNewHive}>
              <Text style={styles.headerSlotActionText}>Add hive</Text>
            </Pressable>
          </View>
        </View>

        {formMode === 'list' ? (
          <View style={styles.hivesBody}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Your hives</Text>
              <Text style={styles.sectionSubtitle}>
                {status === 'loading'
                  ? 'Loading hive inventory...'
                  : `${hives.length} hives tracked`}
              </Text>
            </View>
            {status === 'error' ? (
              <View style={styles.hiveEmpty}>
                <Text style={styles.hiveEmptyText}>Unable to load hives.</Text>
                <Pressable style={styles.secondaryAction} onPress={loadHives}>
                  <Text style={styles.secondaryActionText}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
            {status === 'ready' && hives.length === 0 ? (
              <View style={styles.hiveEmpty}>
                <Text style={styles.hiveEmptyText}>
                  No hives yet. Add your first hive to start tracking.
                </Text>
                <Pressable style={styles.primaryAction} onPress={startNewHive}>
                  <Text style={styles.primaryActionText}>Add first hive</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.hiveList}>
              {hives.map((hive) => (
                <View key={hive.id} style={styles.hiveCard}>
                  <View style={styles.hiveCardHeader}>
                    <View>
                      <Text style={styles.hiveName}>{hive.name}</Text>
                      <Text style={styles.hiveMeta}>
                        {hive.ward_name || profile?.ward_name || 'Ward'} ·{' '}
                        {hive.hive_type || 'Hive type'}
                      </Text>
                    </View>
                    <Text style={styles.hiveCoordinate}>
                      {hive.latitude && hive.longitude
                        ? `${hive.latitude.toFixed(4)}, ${hive.longitude.toFixed(4)}`
                        : 'No location'}
                    </Text>
                  </View>
                  <View style={styles.hiveTags}>
                    <View style={styles.hiveTag}>
                      <Text style={styles.hiveTagText}>
                        Capacity {hive.hive_capacity || '—'}
                      </Text>
                    </View>
                    <View style={styles.hiveTag}>
                      <Text style={styles.hiveTagText}>
                        Sensor {hive.has_sensor ? 'Yes' : 'No'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.hiveActions}>
                    <Pressable style={styles.secondaryAction} onPress={() => startEditHive(hive)}>
                      <Text style={styles.secondaryActionText}>Edit</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryAction} onPress={() => openHealth(hive)}>
                      <Text style={styles.secondaryActionText}>Health</Text>
                    </Pressable>
                    <Pressable
                      style={styles.deleteAction}
                      onPress={() => confirmDelete(hive)}
                      disabled={isDeleting}
                    >
                      <Text style={styles.deleteActionText}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : formMode === 'health' && activeHive ? (
          <HiveHealthScreen
            hive={activeHive}
            apiBaseUrl={apiBaseUrl}
            authHeaders={authHeaders}
            onBack={() => setFormMode('list')}
          />
        ) : (
          <View style={styles.hivesBody}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                {editingId ? 'Edit hive' : 'Add a new hive'}
              </Text>
              <Text style={styles.sectionSubtitle}>
                Pin the hive location or use GPS for accurate placement.
              </Text>
            </View>
            <View style={styles.hiveFormCard}>
              <View style={styles.form}>
                <View style={styles.field}>
                  <Text style={styles.label}>Hive name *</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Hive label"
                    placeholderTextColor="#9DA8B3"
                    value={form.name}
                    onChangeText={(value) => setForm((prev) => ({ ...prev, name: value }))}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Ward *</Text>
                  <View style={styles.pickerWrap}>
                    {wardOptions.map((ward) => (
                      <Pressable
                        key={ward.id}
                        style={[
                          styles.pickerChip,
                          ward.id === form.ward_id && styles.pickerChipActive,
                        ]}
                        onPress={() => setForm((prev) => ({ ...prev, ward_id: ward.id }))}
                      >
                        <Text
                          style={[
                            styles.pickerChipText,
                            ward.id === form.ward_id && styles.pickerChipTextActive,
                          ]}
                        >
                          {ward.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Hive type</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Langstroth, Top bar..."
                    placeholderTextColor="#9DA8B3"
                    value={form.hive_type}
                    onChangeText={(value) => setForm((prev) => ({ ...prev, hive_type: value }))}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Hive capacity</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Number of frames"
                    placeholderTextColor="#9DA8B3"
                    keyboardType="numeric"
                    value={form.hive_capacity}
                    onChangeText={(value) => setForm((prev) => ({ ...prev, hive_capacity: value }))}
                  />
                </View>
                <View style={styles.field}>
                  <Text style={styles.label}>Notes</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    placeholder="Inspection notes, hive condition..."
                    placeholderTextColor="#9DA8B3"
                    value={form.notes}
                    onChangeText={(value) => setForm((prev) => ({ ...prev, notes: value }))}
                    multiline
                  />
                </View>
                <View style={styles.sensorRow}>
                  <View>
                    <Text style={styles.label}>Sensor attached</Text>
                    <Text style={styles.sensorHint}>Turn on if sensors are installed.</Text>
                  </View>
                  <Switch
                    value={form.has_sensor}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, has_sensor: value }))}
                  />
                </View>
                {form.has_sensor ? (
                  <View style={styles.field}>
                    <Text style={styles.label}>Sensor ID</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Sensor identifier"
                      placeholderTextColor="#9DA8B3"
                      value={form.sensor_id}
                      onChangeText={(value) => setForm((prev) => ({ ...prev, sensor_id: value }))}
                    />
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.hiveMapCard}>
              <View style={styles.hiveMapHeader}>
                <Text style={styles.sectionTitle}>Hive location</Text>
                <Text style={styles.sectionSubtitle}>
                  Tap the map to pin or use GPS for accuracy.
                </Text>
                <Text style={styles.hiveMapHint}>
                  {boundaryStatus === 'loading'
                    ? 'Loading ward boundary...'
                    : `Ward: ${selectedWard?.name || 'Makueni'}`}
                </Text>
              </View>
              <View style={styles.hiveMapWrap}>
                <MapView
                  style={styles.hiveMap}
                  initialRegion={mapRegion}
                  onPress={handleMapPress}
                >
                  {wardBoundary.map((polygon, index) => (
                    <Polygon
                      key={`hive-boundary-${index}`}
                      coordinates={polygon}
                      strokeColor="rgba(109, 191, 232, 0.85)"
                      fillColor="rgba(109, 191, 232, 0.12)"
                      strokeWidth={2}
                    />
                  ))}
                  {form.latitude && form.longitude ? (
                    <Marker
                      coordinate={{ latitude: form.latitude, longitude: form.longitude }}
                    />
                  ) : null}
                </MapView>
              </View>
              <View style={styles.hiveMapActions}>
                <Pressable style={styles.secondaryAction} onPress={useWardCenter}>
                  <Text style={styles.secondaryActionText}>Use ward center</Text>
                </Pressable>
                <Pressable style={styles.primaryAction} onPress={useDeviceLocation}>
                  <Text style={styles.primaryActionText}>
                    {locationStatus === 'loading' ? 'Locating...' : 'Use GPS'}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.hiveFormFooter}>
              <Pressable style={styles.secondaryAction} onPress={() => setFormMode('list')}>
                <Text style={styles.secondaryActionText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryAction, isSaving && styles.primaryButtonDisabled]}
                onPress={saveHive}
                disabled={isSaving}
              >
                <Text style={styles.primaryActionText}>
                  {isSaving ? 'Saving...' : 'Save hive'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const HiveHealthScreen = ({ hive, apiBaseUrl, authHeaders, onBack }) => {
  const [statusData, setStatusData] = useState(null);
  const [inspections, setInspections] = useState([]);
  const [yields, setYields] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [inspectionForm, setInspectionForm] = useState({
    queen_present: true,
    occupancy_rate: '',
    notes: '',
    issues: '',
    next_action: '',
  });
  const [yieldForm, setYieldForm] = useState({
    yield_kg: '',
    source: 'manual',
    notes: '',
  });
  const [isSavingInspection, setIsSavingInspection] = useState(false);
  const [isSavingYield, setIsSavingYield] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  const parseOptionalFloat = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const loadHealth = async () => {
    if (!apiBaseUrl || !hive?.id) {
      return;
    }
    try {
      const [statusRes, inspectionsRes, yieldsRes, alertsRes] = await Promise.all([
        fetch(`${apiBaseUrl}/hives/${hive.id}/status`, { headers: { ...authHeaders } }),
        fetch(`${apiBaseUrl}/hives/${hive.id}/inspections?limit=10`, {
          headers: { ...authHeaders },
        }),
        fetch(`${apiBaseUrl}/hives/${hive.id}/yields?limit=10`, {
          headers: { ...authHeaders },
        }),
        fetch(`${apiBaseUrl}/hives/${hive.id}/alerts?status=active`, {
          headers: { ...authHeaders },
        }),
      ]);
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        setStatusData(statusJson);
      }
      if (inspectionsRes.ok) {
        const data = await inspectionsRes.json();
        setInspections(Array.isArray(data) ? data : []);
      }
      if (yieldsRes.ok) {
        const data = await yieldsRes.json();
        setYields(Array.isArray(data) ? data : []);
      }
      if (alertsRes.ok) {
        const data = await alertsRes.json();
        setAlerts(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      // ignore fetch errors for now
    }
  };

  useEffect(() => {
    loadHealth();
  }, [apiBaseUrl, authHeaders, hive?.id]);

  const saveInspection = async () => {
    if (!apiBaseUrl || !hive?.id) {
      return;
    }
    setIsSavingInspection(true);
    const payload = {
      queen_present: inspectionForm.queen_present,
      occupancy_rate: parseOptionalFloat(inspectionForm.occupancy_rate),
      notes: inspectionForm.notes.trim() || null,
      issues: inspectionForm.issues.trim() || null,
      next_action: inspectionForm.next_action.trim() || null,
    };
    try {
      const res = await fetch(`${apiBaseUrl}/hives/${hive.id}/inspections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(raw || 'Failed to log inspection.');
      }
      setInspectionForm({
        queen_present: true,
        occupancy_rate: '',
        notes: '',
        issues: '',
        next_action: '',
      });
      await loadHealth();
    } catch (error) {
      Alert.alert('Inspection failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingInspection(false);
    }
  };

  const saveYield = async () => {
    if (!apiBaseUrl || !hive?.id) {
      return;
    }
    const yieldValue = parseOptionalFloat(yieldForm.yield_kg);
    if (yieldValue === null) {
      Alert.alert('Missing yield', 'Enter the yield in kg.');
      return;
    }
    setIsSavingYield(true);
    try {
      const res = await fetch(`${apiBaseUrl}/hives/${hive.id}/yields`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          yield_kg: yieldValue,
          source: yieldForm.source,
          notes: yieldForm.notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(raw || 'Failed to log yield.');
      }
      setYieldForm({ yield_kg: '', source: 'manual', notes: '' });
      await loadHealth();
    } catch (error) {
      Alert.alert('Yield failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingYield(false);
    }
  };

  const resolveAlert = async (alertId) => {
    if (!apiBaseUrl || !hive?.id) {
      return;
    }
    setIsResolving(true);
    try {
      const res = await fetch(
        `${apiBaseUrl}/hives/${hive.id}/alerts/${alertId}/resolve`,
        {
          method: 'POST',
          headers: { ...authHeaders },
        }
      );
      if (!res.ok) {
        const raw = await res.text();
        throw new Error(raw || 'Failed to resolve alert.');
      }
      await loadHealth();
    } catch (error) {
      Alert.alert('Resolve failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsResolving(false);
    }
  };

  const lastInspection = statusData?.last_inspection || inspections[0] || null;
  const latestYield = statusData?.latest_yield || yields[0] || null;

  return (
    <View style={styles.hivesBody}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{hive.name}</Text>
        <Text style={styles.sectionSubtitle}>
          {hive.ward_name || 'Makueni'} · Hive health & logs
        </Text>
      </View>

      <View style={styles.healthSummary}>
        <View style={styles.healthCard}>
          <Text style={styles.healthLabel}>Last inspection</Text>
          <Text style={styles.healthValue}>
            {lastInspection?.queen_present === null || lastInspection?.queen_present === undefined
              ? 'Pending'
              : lastInspection.queen_present
                ? 'Queen present'
                : 'Queen absent'}
          </Text>
          <Text style={styles.healthMeta}>
            Occupancy {lastInspection?.occupancy_rate ?? '—'}%
          </Text>
        </View>
        <View style={styles.healthCard}>
          <Text style={styles.healthLabel}>Latest yield</Text>
          <Text style={styles.healthValue}>
            {latestYield?.yield_kg !== undefined && latestYield?.yield_kg !== null
              ? `${latestYield.yield_kg} kg`
              : '—'}
          </Text>
          <Text style={styles.healthMeta}>
            Source {latestYield?.source || '—'}
          </Text>
        </View>
      </View>

      <View style={styles.hiveFormCard}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Log inspection</Text>
          <Text style={styles.sectionSubtitle}>
            Capture queen presence, occupancy, and field notes.
          </Text>
        </View>
        <View style={styles.form}>
          <View style={styles.sensorRow}>
            <View>
              <Text style={styles.label}>Queen present</Text>
              <Text style={styles.sensorHint}>Toggle if the queen was sighted.</Text>
            </View>
            <Switch
              value={inspectionForm.queen_present}
              onValueChange={(value) =>
                setInspectionForm((prev) => ({ ...prev, queen_present: value }))
              }
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Occupancy rate (%)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 74"
              placeholderTextColor="#9DA8B3"
              keyboardType="numeric"
              value={inspectionForm.occupancy_rate}
              onChangeText={(value) =>
                setInspectionForm((prev) => ({ ...prev, occupancy_rate: value }))
              }
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Issues</Text>
            <TextInput
              style={styles.input}
              placeholder="Mites, mold, pests..."
              placeholderTextColor="#9DA8B3"
              value={inspectionForm.issues}
              onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, issues: value }))}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Next action</Text>
            <TextInput
              style={styles.input}
              placeholder="Recommended follow-up"
              placeholderTextColor="#9DA8B3"
              value={inspectionForm.next_action}
              onChangeText={(value) =>
                setInspectionForm((prev) => ({ ...prev, next_action: value }))
              }
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Notes</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Inspection notes"
              placeholderTextColor="#9DA8B3"
              value={inspectionForm.notes}
              onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, notes: value }))}
              multiline
            />
          </View>
          <Pressable
            style={[styles.primaryAction, isSavingInspection && styles.primaryButtonDisabled]}
            onPress={saveInspection}
            disabled={isSavingInspection}
          >
            <Text style={styles.primaryActionText}>
              {isSavingInspection ? 'Saving...' : 'Save inspection'}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.hiveFormCard}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Log yield</Text>
          <Text style={styles.sectionSubtitle}>
            Record manual harvests or model estimates.
          </Text>
        </View>
        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Yield (kg)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 2.4"
              placeholderTextColor="#9DA8B3"
              keyboardType="numeric"
              value={yieldForm.yield_kg}
              onChangeText={(value) => setYieldForm((prev) => ({ ...prev, yield_kg: value }))}
            />
          </View>
          <View style={styles.pickerWrap}>
            {['manual', 'model'].map((option) => (
              <Pressable
                key={option}
                style={[
                  styles.pickerChip,
                  yieldForm.source === option && styles.pickerChipActive,
                ]}
                onPress={() => setYieldForm((prev) => ({ ...prev, source: option }))}
              >
                <Text
                  style={[
                    styles.pickerChipText,
                    yieldForm.source === option && styles.pickerChipTextActive,
                  ]}
                >
                  {option === 'manual' ? 'Manual' : 'Model'}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Notes</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Harvest notes"
              placeholderTextColor="#9DA8B3"
              value={yieldForm.notes}
              onChangeText={(value) => setYieldForm((prev) => ({ ...prev, notes: value }))}
              multiline
            />
          </View>
          <Pressable
            style={[styles.primaryAction, isSavingYield && styles.primaryButtonDisabled]}
            onPress={saveYield}
            disabled={isSavingYield}
          >
            <Text style={styles.primaryActionText}>
              {isSavingYield ? 'Saving...' : 'Save yield'}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.healthSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Active alerts</Text>
          <Text style={styles.sectionSubtitle}>
            {alerts.length ? `${alerts.length} open alerts` : 'No active alerts'}
          </Text>
        </View>
        <View style={styles.alertList}>
          {alerts.map((alert) => (
            <View key={alert.id} style={styles.alertItem}>
              <View style={styles.alertBody}>
                <Text style={styles.alertTitle}>{alert.alert_type}</Text>
                <Text style={styles.alertDetail}>{alert.message}</Text>
              </View>
              <Pressable
                style={styles.secondaryAction}
                onPress={() => resolveAlert(alert.id)}
                disabled={isResolving}
              >
                <Text style={styles.secondaryActionText}>Resolve</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>

      <Pressable style={styles.secondaryAction} onPress={onBack}>
        <Text style={styles.secondaryActionText}>Back to hives</Text>
      </Pressable>
    </View>
  );
};

const OnboardingScreen = ({
  form,
  onChange,
  onSubmit,
  isSaving,
  wards,
  wardQuery,
  onWardQuery,
  onSelectWard,
  wardsStatus,
  onRetryWards,
}) => {
  const filteredWards = useMemo(() => {
    if (!wardQuery) {
      return wards;
    }
    const query = wardQuery.toLowerCase();
    return wards.filter((ward) => ward.name.toLowerCase().includes(query));
  }, [wards, wardQuery]);

  return (
    <SafeAreaView style={styles.dashboardSafe}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.onboardingContent}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.stickyHeader}>
          <View style={styles.headerSlot}>
            <View>
              <Text style={styles.headerSlotTitle}>BeeUnity</Text>
              <View style={styles.headerSlotMetaRow}>
                <View style={styles.headerSlotDot} />
                <Text style={styles.headerSlotMeta}>Onboarding</Text>
              </View>
            </View>
          </View>
        </View>
        <View style={styles.onboardingBody}>
        <View style={styles.onboardingHeader}>
          <Text style={styles.dashboardEyebrow}>BeeUnity onboarding</Text>
          <Text style={styles.onboardingTitle}>Set up your apiary profile</Text>
          <Text style={styles.onboardingSubtitle}>
            We tailor queen presence, occupancy, and yield insights to your ward and hive setup.
          </Text>
          <Text style={styles.onboardingHint}>All fields marked * are required.</Text>
        </View>

        <View style={styles.onboardingCard}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Profile details</Text>
            <Text style={styles.sectionSubtitle}>Tell us about your apiary and goals.</Text>
          </View>
          <View style={styles.form}>
            <View style={styles.field}>
              <Text style={styles.label}>Full name *</Text>
              <TextInput
                style={styles.input}
                placeholder="Beekeeper name"
                placeholderTextColor="#9DA8B3"
                value={form.full_name}
                  onChangeText={(value) => onChange('full_name', value)}
                />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Phone number *</Text>
              <TextInput
                style={styles.input}
                placeholder="07xx xxx xxx"
                placeholderTextColor="#9DA8B3"
                keyboardType="phone-pad"
                  value={form.phone_number}
                  onChangeText={(value) => onChange('phone_number', value)}
                />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Ward (Makueni County) *</Text>
              <TextInput
                style={styles.input}
                placeholder="Search ward"
                placeholderTextColor="#9DA8B3"
                value={wardQuery}
                onChangeText={onWardQuery}
              />
              {wardsStatus === 'loading' ? (
                <View style={styles.wardStatus}>
                  <ActivityIndicator color="#E2B25B" />
                  <Text style={styles.wardStatusText}>Loading wards...</Text>
                </View>
              ) : wardsStatus === 'error' ? (
                <View style={styles.wardStatus}>
                  <Text style={styles.wardStatusText}>Unable to load wards.</Text>
                  <Pressable style={styles.wardRetry} onPress={onRetryWards}>
                    <Text style={styles.wardRetryText}>Retry</Text>
                  </Pressable>
                </View>
              ) : (
                <ScrollView style={styles.wardList} contentContainerStyle={styles.wardListContent}>
                  {filteredWards.map((ward) => {
                    const active = form.ward_id === ward.id;
                    return (
                      <Pressable
                        key={ward.id}
                        style={[styles.wardOption, active && styles.wardOptionActive]}
                        onPress={() => onSelectWard(ward)}
                      >
                        <Text style={styles.wardOptionName}>{ward.name}</Text>
                        <Text style={styles.wardOptionMeta}>{ward.subcounty}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Number of hives *</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                placeholderTextColor="#9DA8B3"
                keyboardType="number-pad"
                  value={form.hive_count}
                  onChangeText={(value) => onChange('hive_count', value)}
                />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Years beekeeping *</Text>
              <TextInput
                style={styles.input}
                placeholder="0"
                placeholderTextColor="#9DA8B3"
                keyboardType="number-pad"
                value={form.beekeeping_years}
                  onChangeText={(value) => onChange('beekeeping_years', value)}
                />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Hive type *</Text>
              <TextInput
                style={styles.input}
                placeholder="Langstroth, Top-bar, Traditional"
                placeholderTextColor="#9DA8B3"
                value={form.hive_type}
                  onChangeText={(value) => onChange('hive_type', value)}
                />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Farm size (acres) *</Text>
              <TextInput
                style={styles.input}
                placeholder="0.0"
                placeholderTextColor="#9DA8B3"
                keyboardType="decimal-pad"
                value={form.farm_size_acres}
                  onChangeText={(value) => onChange('farm_size_acres', value)}
                />
              </View>
              <View style={styles.toggleRow}>
                <View>
                  <Text style={styles.toggleLabel}>Connected hive sensors</Text>
                  <Text style={styles.toggleHint}>Audio or temperature loggers installed</Text>
                </View>
                <Switch
                  value={Boolean(form.has_sensors)}
                  onValueChange={(value) => onChange('has_sensors', value)}
                  thumbColor={form.has_sensors ? '#E2B25B' : '#64746B'}
                  trackColor={{ false: '#1B2E26', true: '#2E4C3D' }}
                />
              </View>
            <View style={styles.field}>
              <Text style={styles.label}>Primary goal *</Text>
              <TextInput
                style={styles.input}
                placeholder="Improve yield, reduce absconding, track queen"
                placeholderTextColor="#9DA8B3"
                value={form.primary_goal}
                  onChangeText={(value) => onChange('primary_goal', value)}
                />
              </View>
            </View>

            <Pressable
              style={[styles.primaryButton, isSaving && styles.primaryButtonDisabled]}
              onPress={onSubmit}
              disabled={isSaving}
            >
              {isSaving ? (
                <ActivityIndicator color="#1E1A10" />
              ) : (
                <Text style={styles.primaryButtonText}>Finish setup</Text>
              )}
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

export default function App() {
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({
    displayName: '',
    email: '',
    password: '',
    username: '',
  });
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [profile, setProfile] = useState(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [wards, setWards] = useState([]);
  const [wardQuery, setWardQuery] = useState('');
  const [wardsStatus, setWardsStatus] = useState('idle');
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [isOnboardingSaving, setIsOnboardingSaving] = useState(false);
  const [onboardingForm, setOnboardingForm] = useState({
    full_name: '',
    phone_number: '',
    ward_id: '',
    ward_name: '',
    hive_count: '',
    beekeeping_years: '',
    hive_type: '',
    farm_size_acres: '',
    has_sensors: false,
    primary_goal: '',
  });
  const [isBusy, setIsBusy] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const hasSession = Boolean(session?.accessToken || session?.idToken);

  const discovery = AuthSession.useAutoDiscovery(AUTH_ISSUER);
  const redirectUri = useMemo(resolveRedirectUri, []);
  const useProxy = Boolean(redirectUri?.includes('auth.expo.io'));

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: OIDC_CLIENT_ID,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      scopes: ['openid', 'profile', 'email'],
      usePKCE: true,
    },
    discovery
  );

  const isSignup = mode === 'signup';
  const headline = isSignup ? 'Create your account' : 'Welcome back';
  const helper = isSignup
    ? 'Track queen presence, occupancy, and yield outlook by ward.'
    : 'Sign in to view ward forecasts and hive health insights.';

  const primaryLabel = isSignup ? 'Create account' : 'Continue to BeeUnity Login';
  const secondaryLabel = isSignup
    ? 'Already have an account? Sign in'
    : "New to BeeUnity? Create account";
  const signinNote =
    'We use BeeUnity Auth to protect your account. Continue to sign in securely.';

  useEffect(() => {
    const exchangeCode = async () => {
      if (!request || !discovery || response?.type !== 'success') {
        return;
      }

      setIsBusy(true);
      try {
        const tokenResult = await AuthSession.exchangeCodeAsync(
          {
            clientId: OIDC_CLIENT_ID,
            code: response.params.code,
            redirectUri,
            extraParams: {
              code_verifier: request.codeVerifier,
            },
          },
          discovery
        );
        const issuedAt = Math.floor(Date.now() / 1000);
        const expiresIn = tokenResult.expiresIn ?? tokenResult.expires_in ?? null;
        const expiresAt = expiresIn ? issuedAt + expiresIn : null;
        const accessToken = tokenResult.accessToken ?? tokenResult.access_token ?? null;
        const refreshToken = tokenResult.refreshToken ?? tokenResult.refresh_token ?? null;
        const idToken = tokenResult.idToken ?? tokenResult.id_token ?? null;
        const tokenType = tokenResult.tokenType ?? tokenResult.token_type ?? null;
        const profileFromId = decodeJwtPayload(idToken);
        const nextSession = {
          accessToken,
          refreshToken,
          idToken,
          tokenType,
          issuedAt,
          expiresAt,
          profile: profileFromId ?? null,
        };
        if (profileFromId) {
          setUserProfile(profileFromId);
        }
        await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
        Alert.alert('Signed in', 'Your session is now active.');
      } catch (error) {
        Alert.alert('Sign-in failed', String(error));
      } finally {
        setIsBusy(false);
      }
    };

    if (response?.type === 'error') {
      Alert.alert('Sign-in failed', response.params?.error_description ?? 'Auth error');
    }

    exchangeCode();
  }, [response, request, discovery, redirectUri]);

  const handleSignup = async () => {
    if (!form.username || !form.email || !form.password || !form.displayName) {
      Alert.alert('Missing details', 'Please fill in all required fields.');
      return;
    }

    setIsBusy(true);
    try {
      const res = await fetch(SIGNUP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          email: form.email.trim(),
          display_name: form.displayName.trim(),
        }),
      });

      const rawBody = await res.text();
      let detail = rawBody;
      try {
        const parsed = rawBody ? JSON.parse(rawBody) : {};
        detail = parsed.detail || parsed.message || rawBody;
      } catch (error) {
        detail = rawBody || error;
      }

      if (!res.ok) {
        const message =
          typeof detail === 'string' && detail.trim().length > 0
            ? detail
            : 'Signup failed';
        throw new Error(message);
      }

      Alert.alert('Account created', 'You can now sign in.');
      setMode('signin');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error);
      Alert.alert('Signup failed', message || 'Unknown error');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSignin = async () => {
    if (!request || !discovery) {
      Alert.alert('Auth unavailable', 'OIDC discovery not ready yet.');
      return;
    }
    setIsBusy(true);
    try {
      await promptAsync({ useProxy });
    } catch (error) {
      Alert.alert('Sign-in failed', String(error));
      setIsBusy(false);
    }
  };

  const onPrimary = () => {
    if (isSignup) {
      handleSignup();
    } else {
      handleSignin();
    }
  };

  const onSecondary = () => setMode(isSignup ? 'signin' : 'signup');

  const formFields = useMemo(() => {
    if (isSignup) {
      return [
        {
          key: 'username',
          label: 'Username',
          placeholder: 'farmer.nduku',
          textContentType: 'username',
          autoCapitalize: 'none',
        },
        {
          key: 'displayName',
          label: 'Full name',
          placeholder: 'Farmer Nduku',
          textContentType: 'name',
        },
        {
          key: 'email',
          label: 'Email',
          placeholder: 'farmer@example.com',
          textContentType: 'emailAddress',
          keyboardType: 'email-address',
          autoCapitalize: 'none',
        },
        {
          key: 'password',
          label: 'Password',
          placeholder: 'Create a strong password',
          textContentType: 'newPassword',
          secureTextEntry: true,
        },
      ];
    }

    return [
      {
        key: 'email',
        label: 'Email or username',
        placeholder: 'farmer@example.com',
        textContentType: 'username',
        autoCapitalize: 'none',
      },
      {
        key: 'password',
        label: 'Password',
        placeholder: 'Your password',
        textContentType: 'password',
        secureTextEntry: true,
      },
    ];
  }, [isSignup]);

  const refreshSession = async (currentSession) => {
    if (!currentSession?.refreshToken || !discovery?.tokenEndpoint) {
      return currentSession;
    }

    try {
      const refreshed = await AuthSession.refreshAsync(
        {
          clientId: OIDC_CLIENT_ID,
          refreshToken: currentSession.refreshToken,
        },
        discovery
      );

      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresIn = refreshed.expiresIn ?? refreshed.expires_in ?? null;
      const expiresAt = expiresIn ? issuedAt + expiresIn : currentSession.expiresAt ?? null;
      const nextAccessToken = refreshed.accessToken ?? refreshed.access_token ?? null;
      const nextIdToken = refreshed.idToken ?? refreshed.id_token ?? null;
      const nextRefreshToken = refreshed.refreshToken ?? refreshed.refresh_token ?? null;
      const nextTokenType = refreshed.tokenType ?? refreshed.token_type ?? null;
      const nextProfile = decodeJwtPayload(nextIdToken) ?? currentSession.profile ?? null;
      const nextSession = {
        ...currentSession,
        accessToken: nextAccessToken ?? currentSession.accessToken,
        idToken: nextIdToken ?? currentSession.idToken,
        refreshToken: nextRefreshToken ?? currentSession.refreshToken,
        tokenType: nextTokenType ?? currentSession.tokenType,
        issuedAt,
        expiresAt,
        profile: nextProfile,
      };

      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(nextSession));
      setSession(nextSession);

      if (nextProfile) {
        setUserProfile(nextProfile);
      }

      return nextSession;
    } catch (error) {
      await SecureStore.deleteItemAsync(SESSION_KEY);
      setSession(null);
      setUserProfile(null);
      return null;
    }
  };

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      try {
        const stored = await SecureStore.getItemAsync(SESSION_KEY);
        if (!stored) {
          return;
        }
        const parsed = JSON.parse(stored);
        const profileFromId = parsed.profile || decodeJwtPayload(parsed.idToken);
        if (profileFromId) {
          setUserProfile(profileFromId);
        }

        if (!isSessionExpired(parsed)) {
          if (active) {
            setSession(parsed);
          }
          return;
        }
        if (active) {
          const refreshed = await refreshSession(parsed);
          if (!refreshed) {
            await SecureStore.deleteItemAsync(SESSION_KEY);
          }
        }
      } catch (error) {
        await SecureStore.deleteItemAsync(SESSION_KEY);
        setUserProfile(null);
      } finally {
        if (active) {
          setIsRestoring(false);
        }
      }
    };

    restoreSession();

    return () => {
      active = false;
    };
  }, []);

  const handleSignOut = async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
    setUserProfile(null);
    setProfile(null);
    setNeedsOnboarding(false);
  };

  const handleAuthFailure = async () => {
    await handleSignOut();
    Alert.alert('Session expired', 'Please sign in again to continue.');
  };

  const authHeaders = useMemo(() => {
    if (!session?.accessToken && !session?.idToken) {
      return {};
    }
    const token = session.idToken || session.accessToken;
    return { Authorization: `Bearer ${token}` };
  }, [session]);

  useEffect(() => {
    if (!hasSession) {
      return;
    }
    let active = true;
    const setupNotifications = async () => {
      const permission = await Notifications.getPermissionsAsync();
      let status = permission.status;
      if (status !== 'granted') {
        const request = await Notifications.requestPermissionsAsync();
        status = request.status;
      }
      if (!active || status !== 'granted') {
        return;
      }
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
          name: 'BeeUnity alerts',
          importance: Notifications.AndroidImportance.DEFAULT,
          vibrationPattern: [0, 250, 200, 250],
          lightColor: '#E2B25B',
        });
      }
    };

    setupNotifications();
    return () => {
      active = false;
    };
  }, [hasSession]);

  const handleOnboardingChange = (key, value) => {
    setOnboardingForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleEditProfile = () => {
    if (profile) {
      prefillOnboarding(profile);
    }
    setNeedsOnboarding(true);
  };

  const handleSelectWard = (ward) => {
    setOnboardingForm((prev) => ({
      ...prev,
      ward_id: ward.id,
      ward_name: ward.name,
    }));
    setWardQuery(ward.name);
  };

  const parseOptionalNumber = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const parseOptionalInt = (value) => {
    const parsed = parseOptionalNumber(value);
    if (parsed === null) {
      return null;
    }
    return Math.round(parsed);
  };

  const prefillOnboarding = (source) => {
    if (!source) {
      return;
    }
    if (!wardQuery && (source.ward_name || source.ward_id)) {
      setWardQuery(source.ward_name || source.ward_id);
    }
    setOnboardingForm((prev) => ({
      full_name: prev.full_name || source.full_name || '',
      phone_number: prev.phone_number || source.phone_number || '',
      ward_id: prev.ward_id || source.ward_id || '',
      ward_name: prev.ward_name || source.ward_name || '',
      hive_count: prev.hive_count || (source.hive_count ?? '').toString(),
      beekeeping_years: prev.beekeeping_years || (source.beekeeping_years ?? '').toString(),
      hive_type: prev.hive_type || source.hive_type || '',
      farm_size_acres: prev.farm_size_acres || (source.farm_size_acres ?? '').toString(),
      has_sensors: prev.has_sensors || Boolean(source.has_sensors),
      primary_goal: prev.primary_goal || source.primary_goal || '',
    }));
  };

  const readJsonSafely = async (res) => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return null;
    }
    try {
      return await res.json();
    } catch (error) {
      return null;
    }
  };

  const loadWards = async () => {
    setWardsStatus('loading');
    try {
      const res = await fetch(`${API_BASE_URL}/locations/wards`, {
        headers: { ...authHeaders },
      });
      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        setWardsStatus('error');
        return;
      }
      if (!res.ok) {
        setWardsStatus('error');
        return;
      }
      const data = await readJsonSafely(res);
      setWards(Array.isArray(data) ? data : data.wards || []);
      setWardsStatus('ready');
    } catch (error) {
      setWardsStatus('error');
      // ignore ward loading errors for now
    }
  };

  const loadProfile = async () => {
    if (!session?.accessToken && !session?.idToken) {
      return;
    }
    setIsProfileLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/profile`, {
        headers: { ...authHeaders },
      });
      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        return;
      }
      if (res.status === 404) {
        setNeedsOnboarding(true);
        return;
      }
      if (!res.ok) {
        return;
      }
      const data = await readJsonSafely(res);
      if (!data) {
        return;
      }
      setProfile(data);
      setNeedsOnboarding(!isProfileComplete(data));
      prefillOnboarding(data);
    } catch (error) {
      // ignore profile errors for now
    } finally {
      setIsProfileLoading(false);
    }
  };

  const submitOnboarding = async () => {
    const missingFields = [];
    if (!onboardingForm.full_name.trim()) {
      missingFields.push('full name');
    }
    if (!onboardingForm.phone_number.trim()) {
      missingFields.push('phone number');
    }
    if (!onboardingForm.ward_id) {
      missingFields.push('ward');
    }
    if (!onboardingForm.hive_count) {
      missingFields.push('hive count');
    }
    if (!onboardingForm.beekeeping_years) {
      missingFields.push('beekeeping years');
    }
    if (!onboardingForm.hive_type.trim()) {
      missingFields.push('hive type');
    }
    if (!onboardingForm.farm_size_acres) {
      missingFields.push('farm size');
    }
    if (!onboardingForm.primary_goal.trim()) {
      missingFields.push('primary goal');
    }
    if (missingFields.length > 0) {
      Alert.alert(
        'Missing details',
        `Please add your ${missingFields.join(', ')} to continue.`
      );
      return;
    }

    setIsOnboardingSaving(true);
    try {
      const payload = {
        full_name: onboardingForm.full_name.trim(),
        phone_number: onboardingForm.phone_number.trim() || null,
        ward_id: onboardingForm.ward_id,
        ward_name: onboardingForm.ward_name || null,
        hive_count: parseOptionalInt(onboardingForm.hive_count),
        beekeeping_years: parseOptionalInt(onboardingForm.beekeeping_years),
        hive_type: onboardingForm.hive_type.trim() || null,
        farm_size_acres: parseOptionalNumber(onboardingForm.farm_size_acres),
        has_sensors: Boolean(onboardingForm.has_sensors),
        primary_goal: onboardingForm.primary_goal.trim() || null,
      };

      const res = await fetch(`${API_BASE_URL}/profile/onboarding`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(payload),
      });

      const data = await readJsonSafely(res);
      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        return;
      }
      if (!res.ok) {
        const detail = data?.detail || 'Onboarding failed';
        throw new Error(detail);
      }

      setProfile(data);
      setNeedsOnboarding(!isProfileComplete(data));
    } catch (error) {
      Alert.alert('Onboarding failed', error instanceof Error ? error.message : String(error));
    } finally {
      setIsOnboardingSaving(false);
    }
  };

  useEffect(() => {
    if (!session?.accessToken && !session?.idToken) {
      return;
    }
    loadWards();
    loadProfile();
  }, [session]);

  useEffect(() => {
    if (!hasSession || isProfileLoading) {
      return;
    }
    if (!profile) {
      setNeedsOnboarding(true);
      return;
    }
    setNeedsOnboarding(!isProfileComplete(profile));
  }, [hasSession, isProfileLoading, profile]);

  useEffect(() => {
    if (!userProfile) {
      return;
    }
    const displayName = buildDisplayName(userProfile);
    if (displayName) {
      prefillOnboarding({ full_name: displayName });
    }
  }, [userProfile]);

  useEffect(() => {
    if (!session?.accessToken || !discovery?.userinfoEndpoint) {
      return;
    }
    if (userProfile?.email || userProfile?.name || userProfile?.preferred_username) {
      return;
    }

    const loadUserInfo = async () => {
      try {
        const res = await fetch(discovery.userinfoEndpoint, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (!data) {
          return;
        }
        setUserProfile(data);
        const nextSession = { ...session, profile: data };
        await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(nextSession));
        setSession(nextSession);
      } catch (error) {
        // Ignore userinfo errors; id token claims may still be used.
      }
    };

    loadUserInfo();
  }, [session, discovery, userProfile]);

  useEffect(() => {
    if (!session?.expiresAt || !session?.refreshToken) {
      return undefined;
    }

    const now = Math.floor(Date.now() / 1000);
    const refreshAt = session.expiresAt - REFRESH_BUFFER_SECONDS;
    const delayMs = Math.max(0, refreshAt - now) * 1000;

    const timer = setTimeout(() => {
      refreshSession(session);
    }, delayMs);

    return () => clearTimeout(timer);
  }, [session, discovery]);

  const tabScreenOptions = {
    headerShown: false,
    tabBarActiveTintColor: '#E2B25B',
    tabBarInactiveTintColor: '#7A8E88',
    tabBarStyle: {
      backgroundColor: '#071B16',
      borderTopColor: '#143028',
      borderTopWidth: 1,
      height: 64,
      paddingBottom: 10,
      paddingTop: 6,
    },
    tabBarLabelStyle: {
      fontFamily: BODY_FONT,
      fontSize: 11,
      letterSpacing: 0.2,
    },
  };
  const getTabIcon = (routeName) => {
    switch (routeName) {
      case 'Dashboard':
        return 'grid-outline';
      case 'Hives':
        return 'home-outline';
      case 'Map':
        return 'map-outline';
      case 'Alerts':
        return 'alert-circle-outline';
      case 'Profile':
        return 'person-circle-outline';
      default:
        return 'ellipse-outline';
    }
  };

  if (isRestoring) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#E2B25B" />
          <Text style={styles.loadingText}>Restoring session...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (hasSession && (isProfileLoading || needsOnboarding)) {
    if (isProfileLoading) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color="#E2B25B" />
            <Text style={styles.loadingText}>Loading your profile...</Text>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <OnboardingScreen
        form={onboardingForm}
        onChange={handleOnboardingChange}
        onSubmit={submitOnboarding}
        isSaving={isOnboardingSaving}
        wards={wards}
        wardQuery={wardQuery}
        onWardQuery={setWardQuery}
        onSelectWard={handleSelectWard}
        wardsStatus={wardsStatus}
        onRetryWards={loadWards}
      />
    );
  }

  if (hasSession) {
    return (
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            ...tabScreenOptions,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name={getTabIcon(route.name)} size={size ?? 20} color={color} />
            ),
          })}
        >
          <Tab.Screen name="Dashboard">
            {() => (
              <DashboardStack.Navigator screenOptions={{ headerShown: false }}>
                <DashboardStack.Screen name="DashboardHome">
                  {(navProps) => (
                    <DashboardScreen
                      onSignOut={handleSignOut}
                      onManageHives={() => navProps.navigation.navigate('Hives')}
                      user={userProfile}
                      profile={profile}
                      wards={wards}
                      apiBaseUrl={API_BASE_URL}
                      authHeaders={authHeaders}
                    />
                  )}
                </DashboardStack.Screen>
              </DashboardStack.Navigator>
            )}
          </Tab.Screen>
          <Tab.Screen name="Hives">
            {() => (
              <HivesStack.Navigator screenOptions={{ headerShown: false }}>
                <HivesStack.Screen name="HivesHome">
                  {(navProps) => (
                    <HivesScreen
                      onBack={null}
                      apiBaseUrl={API_BASE_URL}
                      authHeaders={authHeaders}
                      profile={profile}
                      wards={wards}
                      route={navProps.route}
                      navigation={navProps.navigation}
                    />
                  )}
                </HivesStack.Screen>
              </HivesStack.Navigator>
            )}
          </Tab.Screen>
          <Tab.Screen name="Map">
            {() => (
              <MapStack.Navigator screenOptions={{ headerShown: false }}>
                <MapStack.Screen name="MapHome">
                  {(navProps) => (
                    <MapScreen
                      profile={profile}
                      wards={wards}
                      apiBaseUrl={API_BASE_URL}
                      authHeaders={authHeaders}
                      navigation={navProps.navigation}
                    />
                  )}
                </MapStack.Screen>
              </MapStack.Navigator>
            )}
          </Tab.Screen>
          <Tab.Screen name="Alerts">
            {() => (
              <AlertsStack.Navigator screenOptions={{ headerShown: false }}>
                <AlertsStack.Screen name="AlertsHome">
                  {() => <AlertsScreen profile={profile} />}
                </AlertsStack.Screen>
              </AlertsStack.Navigator>
            )}
          </Tab.Screen>
          <Tab.Screen name="Profile">
            {() => (
              <ProfileStack.Navigator screenOptions={{ headerShown: false }}>
                <ProfileStack.Screen name="ProfileHome">
                  {() => (
                    <ProfileScreen
                      user={userProfile}
                      profile={profile}
                      onSignOut={handleSignOut}
                      onEditProfile={handleEditProfile}
                      apiBaseUrl={API_BASE_URL}
                      authHeaders={authHeaders}
                    />
                  )}
                </ProfileStack.Screen>
              </ProfileStack.Navigator>
            )}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.brandEyebrow}>BeeUnity</Text>
            <Text style={styles.brandTitle}>Ward-smart beekeeping</Text>
            <Text style={styles.brandSubtitle}>
              Makueni County hive intelligence for queen presence, occupancy, and yield.
            </Text>
          </View>

          <View style={styles.cardWrap}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{headline}</Text>
              <Text style={styles.cardSubtitle}>{helper}</Text>

              {isSignup ? (
                <View style={styles.form}>
                  {formFields.map((field) => (
                    <View key={field.key} style={styles.field}>
                      <Text style={styles.label}>{field.label}</Text>
                      <TextInput
                        style={styles.input}
                        placeholder={field.placeholder}
                        placeholderTextColor="#9DA8B3"
                        value={form[field.key]}
                        onChangeText={(value) =>
                          setForm((prev) => ({ ...prev, [field.key]: value }))
                        }
                        textContentType={field.textContentType}
                        autoCapitalize={field.autoCapitalize ?? 'none'}
                        keyboardType={field.keyboardType}
                        secureTextEntry={field.secureTextEntry}
                      />
                    </View>
                  ))}
                </View>
              ) : (
                <View style={styles.signinNotice}>
                  <Text style={styles.signinNoticeText}>{signinNote}</Text>
                </View>
              )}

              <Pressable
                style={[styles.primaryButton, isBusy && styles.primaryButtonDisabled]}
                onPress={onPrimary}
                disabled={isBusy}
              >
                {isBusy ? (
                  <ActivityIndicator color="#1E1A10" />
                ) : (
                  <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
                )}
              </Pressable>

              {!isSignup ? (
                <Text style={styles.metaText}>
                {session ? 'Session active.' : 'Forgot your password? Use the Auth portal.'}
                </Text>
              ) : (
                <Text style={styles.metaText}>
                  By continuing, you agree to data use for ward forecasts.
                </Text>
              )}

              <Pressable style={styles.secondaryButton} onPress={onSecondary}>
                <Text style={styles.secondaryButtonText}>{secondaryLabel}</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0B1E17',
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 24,
    flexGrow: 1,
  },
  brand: {
    marginTop: 12,
    marginBottom: 32,
  },
  brandEyebrow: {
    color: '#C9F0DD',
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontSize: 12,
    marginBottom: 8,
    fontFamily: BODY_FONT,
  },
  brandTitle: {
    color: '#F4F1E8',
    fontSize: 28,
    fontWeight: '700',
    fontFamily: HEADING_FONT,
    marginBottom: 8,
  },
  brandSubtitle: {
    color: '#C0C7C2',
    fontSize: 14,
    fontFamily: BODY_FONT,
    lineHeight: 20,
  },
  cardWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#142B22',
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  cardTitle: {
    color: '#F4F1E8',
    fontSize: 22,
    fontWeight: '600',
    fontFamily: HEADING_FONT,
    marginBottom: 6,
    textAlign: 'center',
  },
  cardSubtitle: {
    color: '#A2B1AA',
    fontSize: 13,
    fontFamily: BODY_FONT,
    marginBottom: 18,
    textAlign: 'center',
  },
  form: {
    gap: 14,
  },
  signinNotice: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E3D31',
    backgroundColor: '#0C1C15',
  },
  signinNoticeText: {
    color: '#C9D4CF',
    fontSize: 13,
    fontFamily: BODY_FONT,
    lineHeight: 18,
  },
  field: {
    gap: 6,
  },
  label: {
    color: '#C9D4CF',
    fontSize: 12,
    fontFamily: BODY_FONT,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  input: {
    backgroundColor: '#0C1C15',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#F4F1E8',
    fontFamily: BODY_FONT,
    borderWidth: 1,
    borderColor: '#1E3D31',
  },
  primaryButton: {
    marginTop: 20,
    backgroundColor: '#E2B25B',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: '#1E1A10',
    fontWeight: '700',
    fontSize: 16,
    fontFamily: BODY_FONT,
  },
  secondaryButton: {
    marginTop: 16,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#30453A',
  },
  secondaryButtonText: {
    color: '#D8E2DE',
    fontSize: 14,
    fontFamily: BODY_FONT,
  },
  metaText: {
    marginTop: 12,
    color: '#8E9B94',
    fontSize: 12,
    fontFamily: BODY_FONT,
    textAlign: 'center',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    color: '#C9D4CF',
    fontSize: 13,
    fontFamily: BODY_FONT,
  },
  dashboardSafe: {
    flex: 1,
    backgroundColor: '#071B16',
  },
  dashboardCanvas: {
    flex: 1,
    backgroundColor: '#071B16',
    overflow: 'hidden',
  },
  glowTop: {
    position: 'absolute',
    top: -90,
    right: -70,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: '#2B8A66',
    opacity: 0.35,
  },
  glowBottom: {
    position: 'absolute',
    bottom: -120,
    left: -90,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#E2B25B',
    opacity: 0.18,
  },
  dashboardContent: {
    paddingBottom: 60,
  },
  stickyHeader: {
    backgroundColor: '#071B16',
    minHeight: HEADER_HEIGHT,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#143028',
    justifyContent: 'center',
  },
  headerSlot: {
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerSlotLeft: {
    flex: 1,
    alignItems: 'flex-start',
    paddingRight: 12,
  },
  headerSlotCenter: {
    flex: 1,
    alignItems: 'flex-start',
    paddingHorizontal: 8,
  },
  headerSlotTitle: {
    color: '#F4F1E8',
    fontSize: 18,
    fontFamily: HEADING_FONT,
  },
  headerSlotMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  headerSlotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#7ED9B6',
  },
  headerSlotMeta: {
    color: '#9EB4AA',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  headerSlotAction: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2C4A3B',
    backgroundColor: '#10241C',
  },
  headerSlotActionText: {
    color: '#F3C67E',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  dashboardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  dashboardEyebrow: {
    color: '#7ED9B6',
    fontSize: 11,
    letterSpacing: 3,
    textTransform: 'uppercase',
    fontFamily: BODY_FONT,
  },
  dashboardTitle: {
    color: '#F4F1E8',
    fontSize: 26,
    fontWeight: '600',
    fontFamily: HEADING_FONT,
    marginTop: 8,
  },
  dashboardSubtitle: {
    color: '#AEC0B8',
    fontSize: 13,
    fontFamily: BODY_FONT,
    marginTop: 6,
  },
  dashboardMeta: {
    color: '#8EA39A',
    fontSize: 12,
    fontFamily: BODY_FONT,
    marginTop: 4,
  },
  impactCard: {
    backgroundColor: '#10241C',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1C3B2F',
    marginBottom: 22,
  },
  impactHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 14,
  },
  impactEyebrow: {
    color: '#7ED9B6',
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: BODY_FONT,
  },
  impactTitle: {
    color: '#F4F1E8',
    fontSize: 16,
    fontFamily: HEADING_FONT,
    marginTop: 4,
  },
  impactBadge: {
    backgroundColor: '#2A5342',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  impactBadgeText: {
    color: '#E2B25B',
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  alertsContent: {
    paddingBottom: 60,
  },
  alertsBody: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  alertList: {
    gap: 12,
  },
  alertItem: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    backgroundColor: '#0C1C15',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1E3D31',
  },
  alertDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
  },
  alertBody: {
    flex: 1,
  },
  alertTitle: {
    color: '#F4F1E8',
    fontSize: 14,
    fontFamily: HEADING_FONT,
  },
  alertDetail: {
    color: '#A9B7AF',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  alertAction: {
    color: '#E2B25B',
    fontSize: 12,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  wardCard: {
    backgroundColor: '#0E241C',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1E3F32',
    marginBottom: 20,
  },
  wardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  wardLabel: {
    color: '#9CB7AB',
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: BODY_FONT,
  },
  wardName: {
    color: '#F7EEDB',
    fontSize: 20,
    fontFamily: HEADING_FONT,
    marginTop: 6,
  },
  wardAction: {
    backgroundColor: '#1B3A2D',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  wardActionText: {
    color: '#C7F0DE',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  wardChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  chip: {
    borderRadius: 999,
    backgroundColor: '#102D24',
    borderWidth: 1,
    borderColor: '#1F4134',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    color: '#B9D7C9',
    fontSize: 11,
    fontFamily: BODY_FONT,
  },
  mapScreenContent: {
    paddingBottom: 60,
  },
  mapScreenBody: {
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  mapScreen: {
    flex: 1,
  },
  mapFullView: {
    flex: 1,
  },
  mapOverlayTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 0,
  },
  mapOverlayCard: {
    marginTop: 12,
    marginHorizontal: 24,
    backgroundColor: 'rgba(7, 27, 22, 0.92)',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(31, 60, 48, 0.85)',
  },
  mapOverlayBottom: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 24,
  },
  mapOverlayChips: {
    marginTop: 0,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 16, 13, 0.55)',
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  hiveModalCard: {
    backgroundColor: '#0D221A',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F3C30',
  },
  hiveModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  hiveModalTitle: {
    color: '#F4F1E8',
    fontSize: 18,
    fontFamily: HEADING_FONT,
  },
  hiveModalSubtitle: {
    color: '#9FB3A9',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  modalClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A4A3C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hiveModalGrid: {
    marginTop: 16,
    marginBottom: 18,
    gap: 12,
  },
  hiveModalItem: {
    backgroundColor: '#102D24',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#1F4134',
  },
  hiveModalLabel: {
    color: '#8EB7A5',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  hiveModalValue: {
    color: '#F4F1E8',
    fontSize: 13,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  mapCard: {
    backgroundColor: '#0D221A',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1F3C30',
    marginBottom: 22,
  },
  mapHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  mapTitle: {
    color: '#F4F1E8',
    fontSize: 16,
    fontFamily: HEADING_FONT,
  },
  mapSubtitle: {
    color: '#9FB3A9',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  mapBadge: {
    backgroundColor: '#1B3A2D',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  mapBadgeText: {
    color: '#C7F0DE',
    fontSize: 10,
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  mapViewWrap: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  mapView: {
    height: 220,
    width: '100%',
  },
  mapLegendRow: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    gap: 10,
  },
  mapLegendChip: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(7, 27, 22, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
  },
  mapLegendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  mapLegendLabel: {
    color: '#9FB3A9',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  mapLegendValue: {
    color: '#F4F1E8',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginBottom: 20,
  },
  metricCard: {
    flexBasis: '48%',
    backgroundColor: '#112B22',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1E3E32',
  },
  metricValue: {
    color: '#F7EACB',
    fontSize: 20,
    fontFamily: HEADING_FONT,
  },
  metricLabel: {
    color: '#A6C1B5',
    fontSize: 12,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  metricNote: {
    color: '#7F9B8E',
    fontSize: 11,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  pulseCard: {
    backgroundColor: '#152F25',
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
  },
  pulseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  pulseTitle: {
    color: '#F4F1E8',
    fontSize: 16,
    fontFamily: HEADING_FONT,
  },
  pulseSubtitle: {
    color: '#A6B9B2',
    fontSize: 12,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  pulseBadge: {
    backgroundColor: '#E2B25B',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  pulseBadgeText: {
    color: '#1E1A10',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  pulseRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  pulseActions: {
    marginTop: 16,
    gap: 12,
  },
  pulseAction: {
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#0C1C15',
    borderWidth: 1,
    borderColor: '#1E3D31',
  },
  pulseActionTitle: {
    color: '#F4F1E8',
    fontSize: 13,
    fontFamily: HEADING_FONT,
  },
  pulseActionDetail: {
    color: '#A9B7AF',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  pulseStat: {
    flex: 1,
    backgroundColor: '#0F231C',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1C3C30',
  },
  pulseValue: {
    color: '#F4E6C4',
    fontSize: 16,
    fontFamily: HEADING_FONT,
  },
  pulseLabel: {
    color: '#97B0A5',
    fontSize: 11,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  yieldCard: {
    backgroundColor: '#0F221B',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F3E31',
    marginBottom: 30,
  },
  yieldHeader: {
    marginBottom: 12,
  },
  yieldTitle: {
    color: '#F4F1E8',
    fontSize: 16,
    fontFamily: HEADING_FONT,
  },
  yieldSubtitle: {
    color: '#A6B9B2',
    fontSize: 12,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  yieldBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  yieldValue: {
    color: '#E2B25B',
    fontSize: 28,
    fontFamily: HEADING_FONT,
  },
  yieldLabel: {
    color: '#9EB2A7',
    fontSize: 11,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  sparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: 42,
  },
  sparkBar: {
    width: 6,
    borderRadius: 6,
    backgroundColor: '#2D6B52',
  },
  yieldActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  primaryAction: {
    backgroundColor: '#E2B25B',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexGrow: 1,
  },
  primaryActionText: {
    color: '#1E1A10',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: BODY_FONT,
    textAlign: 'center',
  },
  secondaryAction: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2F4A3D',
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexGrow: 1,
  },
  secondaryActionText: {
    color: '#D8E2DE',
    fontSize: 12,
    fontFamily: BODY_FONT,
    textAlign: 'center',
  },
  hiveAction: {
    marginTop: 16,
    backgroundColor: '#1B3A2D',
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: 'center',
  },
  hiveActionText: {
    color: '#C7F0DE',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  hivesContent: {
    paddingBottom: 60,
  },
  hivesBody: {
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 18,
  },
  hiveEmpty: {
    backgroundColor: '#0C1F18',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1C3A2F',
    gap: 12,
  },
  hiveEmptyText: {
    color: '#B9C9C1',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  hiveList: {
    gap: 14,
  },
  hiveCard: {
    backgroundColor: '#0F241C',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1E3C30',
  },
  hiveCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  hiveName: {
    color: '#F4EBD7',
    fontSize: 16,
    fontFamily: HEADING_FONT,
  },
  hiveMeta: {
    color: '#95AAA0',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  hiveCoordinate: {
    color: '#7ED9B6',
    fontSize: 11,
    fontFamily: BODY_FONT,
  },
  hiveTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  hiveTag: {
    backgroundColor: '#102D24',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1F4134',
  },
  hiveTagText: {
    color: '#B9D7C9',
    fontSize: 11,
    fontFamily: BODY_FONT,
  },
  hiveActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  deleteAction: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#4D2B2B',
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexGrow: 1,
  },
  deleteActionText: {
    color: '#F57C73',
    fontSize: 12,
    fontFamily: BODY_FONT,
    textAlign: 'center',
  },
  hiveFormCard: {
    backgroundColor: '#0F241C',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1E3C30',
  },
  textArea: {
    minHeight: 90,
    textAlignVertical: 'top',
  },
  sensorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  sensorHint: {
    color: '#7F9B8E',
    fontSize: 11,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  hiveMapCard: {
    backgroundColor: '#0D221A',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1F3C30',
  },
  hiveMapHeader: {
    marginBottom: 10,
  },
  hiveMapHint: {
    color: '#7F9B8E',
    fontSize: 11,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  hiveMapWrap: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  hiveMap: {
    height: 220,
    width: '100%',
  },
  hiveMapActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  hiveFormFooter: {
    flexDirection: 'row',
    gap: 10,
  },
  pickerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pickerChip: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1E3D31',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pickerChipActive: {
    backgroundColor: '#1B3A2D',
    borderColor: '#2A5A45',
  },
  pickerChipText: {
    color: '#C2D4CB',
    fontSize: 11,
    fontFamily: BODY_FONT,
  },
  pickerChipTextActive: {
    color: '#E2F2EA',
  },
  profileContent: {
    paddingBottom: 60,
  },
  profileBody: {
    paddingHorizontal: 24,
    paddingTop: 12,
    gap: 16,
  },
  profileHero: {
    backgroundColor: '#0D221A',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F3C30',
  },
  profileHeroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  profileAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1B3A2D',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A4A3C',
  },
  profileAvatarText: {
    color: '#F4F1E8',
    fontSize: 18,
    fontFamily: HEADING_FONT,
  },
  profileHeroMeta: {
    flex: 1,
  },
  profileHeroName: {
    color: '#F4F1E8',
    fontSize: 18,
    fontFamily: HEADING_FONT,
  },
  profileHeroEmail: {
    color: '#9FB3A9',
    fontSize: 12,
    marginTop: 4,
    fontFamily: BODY_FONT,
  },
  profileHeroWard: {
    color: '#C9D4CF',
    fontSize: 12,
    marginTop: 6,
    fontFamily: BODY_FONT,
  },
  profileStatRow: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 10,
  },
  profileStatCard: {
    flex: 1,
    backgroundColor: '#102D24',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#1F4134',
  },
  profileStatValue: {
    color: '#F4F1E8',
    fontSize: 13,
    fontFamily: HEADING_FONT,
  },
  profileStatLabel: {
    color: '#8EB7A5',
    fontSize: 11,
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: BODY_FONT,
  },
  profileEditButton: {
    alignItems: 'center',
  },
  profileCard: {
    backgroundColor: '#0D221A',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F3C30',
  },
  profileList: {
    marginTop: 12,
    gap: 12,
  },
  profileRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#1B3A2D',
    paddingBottom: 10,
  },
  profileLabel: {
    color: '#9CB7AB',
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    fontFamily: BODY_FONT,
  },
  profileValue: {
    color: '#F4F1E8',
    fontSize: 14,
    fontFamily: HEADING_FONT,
    marginTop: 4,
  },
  onboardingContent: {
    paddingBottom: 60,
  },
  onboardingBody: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
  onboardingHeader: {
    marginBottom: 20,
  },
  onboardingTitle: {
    color: '#F4F1E8',
    fontSize: 24,
    fontFamily: HEADING_FONT,
    marginTop: 10,
  },
  onboardingSubtitle: {
    color: '#A6B9B2',
    fontSize: 13,
    fontFamily: BODY_FONT,
    marginTop: 8,
    lineHeight: 18,
  },
  onboardingHint: {
    color: '#7F9B8E',
    fontSize: 12,
    fontFamily: BODY_FONT,
    marginTop: 10,
  },
  onboardingCard: {
    backgroundColor: '#0F241C',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1E3C30',
  },
  sectionHeader: {
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#F4EBD7',
    fontSize: 15,
    fontFamily: HEADING_FONT,
  },
  sectionSubtitle: {
    color: '#93A89D',
    fontSize: 12,
    fontFamily: BODY_FONT,
    marginTop: 4,
  },
  wardList: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1C3A2F',
    maxHeight: 180,
  },
  wardListContent: {
    paddingBottom: 4,
  },
  wardStatus: {
    marginTop: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1C3A2F',
    backgroundColor: '#0C1F18',
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  wardStatusText: {
    color: '#9CB4AA',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  wardRetry: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: '#1D3A2E',
  },
  wardRetryText: {
    color: '#E2B25B',
    fontSize: 12,
    fontFamily: BODY_FONT,
  },
  wardOption: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1A352B',
  },
  wardOptionActive: {
    backgroundColor: '#173226',
  },
  wardOptionName: {
    color: '#E7DFC8',
    fontSize: 13,
    fontFamily: BODY_FONT,
  },
  wardOptionMeta: {
    color: '#8EA59A',
    fontSize: 11,
    fontFamily: BODY_FONT,
    marginTop: 2,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  toggleLabel: {
    color: '#C9D4CF',
    fontSize: 13,
    fontFamily: BODY_FONT,
  },
  toggleHint: {
    color: '#7E958B',
    fontSize: 11,
    fontFamily: BODY_FONT,
    marginTop: 4,
  },
  dashboardBody: {
    paddingHorizontal: 24,
    paddingTop: 16,
  },
});
