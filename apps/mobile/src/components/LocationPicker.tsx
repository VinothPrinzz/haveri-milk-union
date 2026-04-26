import React, { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, fonts, radius, shadows } from "../lib/theme";

/**
 * LocationPicker — bottom-sheet modal for selecting the delivery location.
 *
 * Spec §6.3:
 *   • Overlay `fixed inset-0 z-50 bg-foreground/40` with fade in/out
 *   • Sheet slides from y:100% → 0 (spring damping 28, stiffness 300)
 *   • `absolute bottom-0 bg-card rounded-t-3xl`
 *   • Drag handle: 40×4 rounded-full bg-muted-foreground/30
 *   • Title: "Select Delivery Location" (font-heading lg bold) + X close
 *   • List row `p-4 rounded-2xl tap-target`
 *       Selected:   bg-primary/10 + 2px primary border
 *       Unselected: bg-muted/50 + 2px transparent border
 *       Content: emoji (text-2xl) + name (font-heading semibold)
 *                + "📍 Delivery Zone" sublabel (xs muted)
 *                + green check circle (24×24 bg-primary) when selected
 *
 * React Native translation:
 *   • RN Modal + transparent backdrop (gives us z-index + android back-button support)
 *   • Animated.timing for slide + overlay fade (simpler than spring without Reanimated)
 *   • Tap overlay to close
 */

export interface LocationOption {
  id: string;
  name: string;
  emoji: string;
  sublabel?: string;
}

interface LocationPickerProps {
  visible: boolean;
  selected: string;
  locations: LocationOption[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

const SCREEN_HEIGHT = Dimensions.get("window").height;

export default function LocationPicker({
  visible,
  selected,
  locations,
  onSelect,
  onClose,
}: LocationPickerProps) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          damping: 28,          // spec §6.3
          stiffness: 300,
          mass: 1,
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SCREEN_HEIGHT,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, translateY, overlayOpacity]);

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Overlay */}
      <Animated.View
        style={[styles.overlay, { opacity: overlayOpacity }]}
        pointerEvents={visible ? "auto" : "none"}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      {/* Sheet */}
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, 16) },
          { transform: [{ translateY }] },
        ]}
      >
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Title row */}
        <View style={styles.titleRow}>
          <Text style={styles.title}>Select Delivery Location</Text>
          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            style={styles.closeBtn}
            accessibilityLabel="Close"
          >
            <Text style={styles.closeIcon}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Location list */}
        <ScrollView
          style={styles.list}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {locations.length === 0 ? (
            <Text style={styles.emptyMsg}>No delivery locations available</Text>
          ) : (
            locations.map((loc) => {
              const isSelected = loc.id === selected;
              return (
                <TouchableOpacity
                  key={loc.id}
                  activeOpacity={0.75}
                  onPress={() => handleSelect(loc.id)}
                  style={[
                    styles.row,
                    isSelected ? styles.rowSelected : styles.rowUnselected,
                  ]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={styles.rowEmoji}>{loc.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {loc.name}
                    </Text>
                    <Text style={styles.rowSub}>
                      📍 {loc.sublabel ?? "Delivery Zone"}
                    </Text>
                  </View>
                  {isSelected && (
                    <View style={styles.checkCircle}>
                      <Text style={styles.checkIcon}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay40, // rgba(13,27,42,0.40)
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "80%",
    backgroundColor: colors.card,
    borderTopLeftRadius: radius["3xl"],   // 24px — rounded-t-3xl
    borderTopRightRadius: radius["3xl"],
    paddingTop: 10,
    paddingHorizontal: 16,
    ...shadows.lg,
  },
  handle: {
    alignSelf: "center",
    width: 40,           // spec
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(107,114,128,0.3)", // muted-foreground/30
    marginBottom: 16,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    fontFamily: fonts.headingExtra,
    fontSize: 15,
    color: colors.foreground,
    flex: 1,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.muted,
  },
  closeIcon: {
    fontSize: 14,
    fontFamily: fonts.bold,
    color: colors.mutedForeground,
  },
  list: {
    marginBottom: 8,
  },
  emptyMsg: {
    textAlign: "center",
    padding: 24,
    fontSize: 13,
    color: colors.mutedForeground,
    fontFamily: fonts.medium,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,                     // spec: p-4
    borderRadius: radius.xxl,        // rounded-2xl
    borderWidth: 2,
    minHeight: 44,
  },
  rowSelected: {
    backgroundColor: "rgba(20,72,204,0.10)",  // primary/10
    borderColor: colors.primary,
  },
  rowUnselected: {
    backgroundColor: "rgba(243,244,247,0.5)", // muted/50
    borderColor: "transparent",
  },
  rowEmoji: {
    fontSize: 24,                    // text-2xl
  },
  rowName: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: colors.foreground,
  },
  rowSub: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  checkCircle: {
    width: 24,                       // spec: 24×24 bg-primary
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  checkIcon: {
    color: colors.primaryForeground,
    fontSize: 13,
    fontFamily: fonts.extrabold,
  },
});