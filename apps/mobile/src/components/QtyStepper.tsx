import React, { useState } from "react";
import {
  StyleProp,
  StyleSheet,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from "react-native";
import { colors, fonts } from "../lib/theme";

/**
 * QtyStepper — a single editable quantity box (no +/- buttons).
 *
 * Dealers type the quantity directly (e.g. 100) instead of tapping a
 * button repeatedly. One callback (`onSet`) fires with the final
 * clamped value on blur/submit. The control is a fixed-width, centered,
 * primary-outlined box so it reads the same on every page.
 */
interface QtyStepperProps {
  value: number;
  /** Absolute-quantity setter. Called with the clamped final value. */
  onSet: (qty: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}

export default function QtyStepper({
  value,
  onSet,
  min = 0,
  max = 99999,
  disabled = false,
  containerStyle,
  inputStyle,
  accessibilityLabel = "Quantity",
}: QtyStepperProps) {
  // draft: in-progress text while typing. null = not editing (show value).
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(Math.max(n, min), max);
  const shown = draft ?? String(value);

  const commit = () => {
    if (draft == null) return;
    const n = parseInt(draft.replace(/[^0-9]/g, ""), 10);
    onSet(Number.isNaN(n) ? min : clamp(n));
    setDraft(null);
  };

  return (
    <View
      style={[styles.container, disabled && styles.containerDisabled, containerStyle]}
    >
      <TextInput
        style={[styles.input, inputStyle]}
        keyboardType="number-pad"
        value={shown}
        editable={!disabled}
        selectTextOnFocus
        maxLength={5}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        returnKeyType="done"
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 68,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  containerDisabled: {
    opacity: 0.4,
  },
  input: {
    width: "100%",
    height: "100%",
    textAlign: "center",
    fontSize: 15,
    fontFamily: fonts.extrabold,
    color: colors.primary,
    paddingVertical: 0,
    paddingHorizontal: 4,
  },
});
