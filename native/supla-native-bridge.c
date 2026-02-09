#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <openssl/evp.h>

#include "log.h"
#include "proto.h"
#include "supla-client.h"

#define BRIDGE_NAME_DEFAULT "Homebridge SUPLA Native Bridge"
#define BRIDGE_SOFTVER_DEFAULT "homebridge-supla-plugin-native/1.0"
#define CHANNEL_CAPACITY_INITIAL 128
#define RELATION_CAPACITY_INITIAL 64
#define INPUT_BUFFER_CAPACITY 32768
#define LINE_BUFFER_CAPACITY 4096
#define BASE64_VALUE_CAPACITY 64
#define BASE64_EXTENDED_CAPACITY 32768
#define DEFAULT_CONNECT_TIMEOUT_MS 5000
#define DEFAULT_RECONNECT_DELAY_MS 2000
#define VALUE_IGNORE -1

typedef struct {
  int id;
  int function_id;
  int location_id;
  int device_id;
  int type;
  int alt_icon;
  int user_icon;
  unsigned long long flags;
  int protocol_version;
  int online;
  int sub_value_type;
  unsigned char value[SUPLA_CHANNELVALUE_SIZE];
  unsigned char sub_value[SUPLA_CHANNELVALUE_SIZE];
  char caption[SUPLA_CHANNEL_CAPTION_MAXSIZE];
  bool has_metadata;
  bool has_value;
} ChannelCacheEntry;

typedef struct {
  int child_id;
  int parent_id;
  int relation_type;
} RelationEntry;

typedef struct {
  ChannelCacheEntry *items;
  size_t size;
  size_t capacity;
} ChannelCache;

typedef struct {
  RelationEntry *items;
  size_t size;
  size_t capacity;
} RelationCache;

typedef struct {
  char host[256];
  int port;
  bool ssl_enabled;
  char email[SUPLA_EMAIL_MAXSIZE];
  char password[SUPLA_PASSWORD_MAXSIZE];
  unsigned char guid[SUPLA_GUID_SIZE];
  unsigned char auth_key[SUPLA_AUTHKEY_SIZE];
  unsigned char protocol_version;
  char name[SUPLA_CLIENT_NAME_MAXSIZE];
  char soft_ver[SUPLA_SOFTVER_MAXSIZE];
  int connect_timeout_ms;
  int reconnect_delay_ms;
} BridgeConfig;

typedef struct {
  BridgeConfig config;
  void *client;
  ChannelCache channels;
  RelationCache relations;
  bool channels_eol_seen;
  bool registered;
  bool shutdown_requested;
  char input_buffer[INPUT_BUFFER_CAPACITY];
  size_t input_buffer_size;
} BridgeContext;

static volatile sig_atomic_t g_should_exit = 0;

static void on_signal(int sig) {
  (void)sig;
  g_should_exit = 1;
}

static bool ensure_channel_capacity(ChannelCache *cache, size_t minimum) {
  if (cache->capacity >= minimum) {
    return true;
  }

  size_t next = cache->capacity == 0 ? CHANNEL_CAPACITY_INITIAL : cache->capacity;
  while (next < minimum) {
    next *= 2;
  }

  ChannelCacheEntry *resized = (ChannelCacheEntry *)realloc(cache->items, next * sizeof(ChannelCacheEntry));
  if (resized == NULL) {
    return false;
  }

  cache->items = resized;
  cache->capacity = next;
  return true;
}

static bool ensure_relation_capacity(RelationCache *cache, size_t minimum) {
  if (cache->capacity >= minimum) {
    return true;
  }

  size_t next = cache->capacity == 0 ? RELATION_CAPACITY_INITIAL : cache->capacity;
  while (next < minimum) {
    next *= 2;
  }

  RelationEntry *resized = (RelationEntry *)realloc(cache->items, next * sizeof(RelationEntry));
  if (resized == NULL) {
    return false;
  }

  cache->items = resized;
  cache->capacity = next;
  return true;
}

static ChannelCacheEntry *find_channel(ChannelCache *cache, int id) {
  for (size_t i = 0; i < cache->size; i++) {
    if (cache->items[i].id == id) {
      return &cache->items[i];
    }
  }

  return NULL;
}

static ChannelCacheEntry *find_or_create_channel(ChannelCache *cache, int id) {
  ChannelCacheEntry *existing = find_channel(cache, id);
  if (existing != NULL) {
    return existing;
  }

  if (!ensure_channel_capacity(cache, cache->size + 1)) {
    return NULL;
  }

  ChannelCacheEntry *entry = &cache->items[cache->size++];
  memset(entry, 0, sizeof(ChannelCacheEntry));
  entry->id = id;
  entry->online = SUPLA_CHANNEL_ONLINE_FLAG_OFFLINE;
  return entry;
}

static void clear_relations(RelationCache *cache) {
  cache->size = 0;
}

static void upsert_relation(RelationCache *cache, int child_id, int parent_id, int relation_type) {
  for (size_t i = 0; i < cache->size; i++) {
    RelationEntry *entry = &cache->items[i];
    if (entry->child_id == child_id && entry->relation_type == relation_type) {
      entry->parent_id = parent_id;
      return;
    }
  }

  if (!ensure_relation_capacity(cache, cache->size + 1)) {
    return;
  }

  RelationEntry *entry = &cache->items[cache->size++];
  entry->child_id = child_id;
  entry->parent_id = parent_id;
  entry->relation_type = relation_type;
}

static void json_escape_print(const char *value) {
  putchar('"');
  if (value != NULL) {
    for (const unsigned char *ptr = (const unsigned char *)value; *ptr != 0; ptr++) {
      switch (*ptr) {
        case '"':
          fputs("\\\"", stdout);
          break;
        case '\\':
          fputs("\\\\", stdout);
          break;
        case '\b':
          fputs("\\b", stdout);
          break;
        case '\f':
          fputs("\\f", stdout);
          break;
        case '\n':
          fputs("\\n", stdout);
          break;
        case '\r':
          fputs("\\r", stdout);
          break;
        case '\t':
          fputs("\\t", stdout);
          break;
        default:
          if (*ptr < 0x20) {
            fprintf(stdout, "\\u%04x", (unsigned int)*ptr);
          } else {
            fputc(*ptr, stdout);
          }
      }
    }
  }
  putchar('"');
}

static void base64_encode(const unsigned char *input, size_t input_size, char *output, size_t output_size) {
  const size_t encoded_size = 4 * ((input_size + 2) / 3);
  if (output_size <= encoded_size) {
    if (output_size > 0) {
      output[0] = '\0';
    }
    return;
  }

  const int result = EVP_EncodeBlock((unsigned char *)output, input, (int)input_size);
  if (result < 0) {
    output[0] = '\0';
    return;
  }

  output[result] = '\0';
}

static const char *log_level_name(int pri) {
  switch (pri) {
    case LOG_EMERG:
    case LOG_ALERT:
    case LOG_CRIT:
    case LOG_ERR:
      return "error";
    case LOG_WARNING:
      return "warn";
    case LOG_NOTICE:
    case LOG_INFO:
      return "info";
    default:
      return "debug";
  }
}

static int log_callback(int pri, const char *message) {
  fputs("{\"type\":\"log\",\"level\":", stdout);
  json_escape_print(log_level_name(pri));
  fputs(",\"message\":", stdout);
  json_escape_print(message == NULL ? "" : message);
  fputs("}\n", stdout);
  fflush(stdout);
  return 1;
}

static void emit_error_event(const char *code, const char *message) {
  fputs("{\"type\":\"error\",\"code\":", stdout);
  json_escape_print(code == NULL ? "unknown" : code);
  fputs(",\"message\":", stdout);
  json_escape_print(message == NULL ? "" : message);
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_status_event(const char *status) {
  fputs("{\"type\":\"status\",\"status\":", stdout);
  json_escape_print(status);
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_registered_event(const TSC_SuplaRegisterClientResult_D *result) {
  fprintf(stdout,
          "{\"type\":\"registered\",\"clientId\":%d,\"locations\":%d,\"channels\":%d,\"channelGroups\":%d,\"scenes\":%d,\"activityTimeout\":%u,\"version\":%u}\n",
          result->ClientID,
          result->LocationCount,
          result->ChannelCount,
          result->ChannelGroupCount,
          result->SceneCount,
          result->activity_timeout,
          result->version);
  fflush(stdout);
}

static void emit_action_result(const char *request_id, bool ok, const char *message) {
  fputs("{\"type\":\"action_result\",\"requestId\":", stdout);
  json_escape_print(request_id == NULL ? "" : request_id);
  fprintf(stdout, ",\"ok\":%s", ok ? "true" : "false");
  if (message != NULL) {
    fputs(",\"message\":", stdout);
    json_escape_print(message);
  }
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_channel_update_event(const TSC_SuplaChannel_E *channel) {
  char value_encoded[BASE64_VALUE_CAPACITY];
  char sub_value_encoded[BASE64_VALUE_CAPACITY];
  base64_encode((const unsigned char *)channel->value.value, SUPLA_CHANNELVALUE_SIZE, value_encoded, sizeof(value_encoded));
  base64_encode((const unsigned char *)channel->value.sub_value, SUPLA_CHANNELVALUE_SIZE, sub_value_encoded, sizeof(sub_value_encoded));

  fputs("{\"type\":\"channel_update\"", stdout);
  fprintf(stdout,
          ",\"id\":%d,\"deviceId\":%d,\"locationId\":%d,\"functionId\":%d,\"channelType\":%d,\"altIcon\":%d,\"userIcon\":%d,\"flags\":%llu,\"protocolVersion\":%u,\"online\":%d",
          channel->Id,
          channel->DeviceID,
          channel->LocationID,
          channel->Func,
          channel->Type,
          channel->AltIcon,
          channel->UserIcon,
          (unsigned long long)channel->Flags,
          channel->ProtocolVersion,
          channel->online);

  fputs(",\"caption\":", stdout);
  json_escape_print(channel->Caption);
  fputs(",\"value\":", stdout);
  json_escape_print(value_encoded);
  fputs(",\"subValue\":", stdout);
  json_escape_print(sub_value_encoded);
  fprintf(stdout, ",\"subValueType\":%d,\"eol\":%d}", channel->value.sub_value_type, channel->EOL);
  fputc('\n', stdout);
  fflush(stdout);
}

static void emit_channel_value_event(const TSC_SuplaChannelValue_B *value) {
  char value_encoded[BASE64_VALUE_CAPACITY];
  char sub_value_encoded[BASE64_VALUE_CAPACITY];
  base64_encode((const unsigned char *)value->value.value, SUPLA_CHANNELVALUE_SIZE, value_encoded, sizeof(value_encoded));
  base64_encode((const unsigned char *)value->value.sub_value, SUPLA_CHANNELVALUE_SIZE, sub_value_encoded, sizeof(sub_value_encoded));

  fprintf(stdout,
          "{\"type\":\"channel_value_update\",\"id\":%d,\"online\":%d,\"subValueType\":%d,\"eol\":%d,\"value\":",
          value->Id,
          value->online,
          value->value.sub_value_type,
          value->EOL);
  json_escape_print(value_encoded);
  fputs(",\"subValue\":", stdout);
  json_escape_print(sub_value_encoded);
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_channel_extended_value_event(const TSC_SuplaChannelExtendedValue *value) {
  char encoded[BASE64_EXTENDED_CAPACITY];
  base64_encode((const unsigned char *)value->value.value, value->value.size, encoded, sizeof(encoded));

  fprintf(stdout,
          "{\"type\":\"channel_extended_value_update\",\"id\":%d,\"extendedType\":%d,\"size\":%u,\"value\":",
          value->Id,
          value->value.type,
          value->value.size);
  json_escape_print(encoded);
  fputs("}\n", stdout);
  fflush(stdout);
}

static void emit_channel_relation_event(const TSC_SuplaChannelRelation *relation) {
  fprintf(stdout,
          "{\"type\":\"channel_relation_update\",\"childId\":%d,\"parentId\":%d,\"relationType\":%d,\"eol\":%d}\n",
          relation->Id,
          relation->ParentId,
          relation->Type,
          relation->EOL);
  fflush(stdout);
}

static bool parse_bool_string(const char *value, bool default_value) {
  if (value == NULL) {
    return default_value;
  }

  if (strcasecmp(value, "1") == 0 || strcasecmp(value, "true") == 0 || strcasecmp(value, "yes") == 0) {
    return true;
  }

  if (strcasecmp(value, "0") == 0 || strcasecmp(value, "false") == 0 || strcasecmp(value, "no") == 0) {
    return false;
  }

  return default_value;
}

static bool parse_int_string(const char *value, int *output) {
  if (value == NULL || output == NULL) {
    return false;
  }

  errno = 0;
  char *end_ptr = NULL;
  long parsed = strtol(value, &end_ptr, 10);
  if (errno != 0 || end_ptr == value || *end_ptr != '\0') {
    return false;
  }

  *output = (int)parsed;
  return true;
}

static bool parse_float_to_hundredths(const char *value, int16_t *output) {
  if (value == NULL || output == NULL) {
    return false;
  }

  errno = 0;
  char *end_ptr = NULL;
  double parsed = strtod(value, &end_ptr);
  if (errno != 0 || end_ptr == value || *end_ptr != '\0') {
    return false;
  }

  const long scaled = lround(parsed * 100.0);
  if (scaled < INT16_MIN || scaled > INT16_MAX) {
    return false;
  }

  *output = (int16_t)scaled;
  return true;
}

static bool parse_hex_bytes(const char *hex, unsigned char *output, size_t output_size) {
  if (hex == NULL || output == NULL) {
    return false;
  }

  const size_t expected_length = output_size * 2;
  const size_t actual_length = strlen(hex);
  if (actual_length != expected_length) {
    return false;
  }

  for (size_t index = 0; index < output_size; index++) {
    char pair[3] = {hex[index * 2], hex[index * 2 + 1], 0};
    char *end_ptr = NULL;
    errno = 0;
    long value = strtol(pair, &end_ptr, 16);
    if (errno != 0 || end_ptr == pair || *end_ptr != '\0' || value < 0 || value > 255) {
      return false;
    }
    output[index] = (unsigned char)value;
  }

  return true;
}

static int map_action_name(const char *action) {
  if (strcasecmp(action, "OPEN") == 0) {
    return ACTION_OPEN;
  }
  if (strcasecmp(action, "CLOSE") == 0) {
    return ACTION_CLOSE;
  }
  if (strcasecmp(action, "SHUT") == 0) {
    return ACTION_SHUT;
  }
  if (strcasecmp(action, "REVEAL") == 0) {
    return ACTION_REVEAL;
  }
  if (strcasecmp(action, "REVEAL_PARTIALLY") == 0) {
    return ACTION_REVEAL_PARTIALLY;
  }
  if (strcasecmp(action, "SHUT_PARTIALLY") == 0) {
    return ACTION_SHUT_PARTIALLY;
  }
  if (strcasecmp(action, "TURN_ON") == 0) {
    return ACTION_TURN_ON;
  }
  if (strcasecmp(action, "TURN_OFF") == 0) {
    return ACTION_TURN_OFF;
  }
  if (strcasecmp(action, "SET_RGBW_PARAMETERS") == 0) {
    return ACTION_SET_RGBW_PARAMETERS;
  }
  if (strcasecmp(action, "OPEN_CLOSE") == 0) {
    return ACTION_OPEN_CLOSE;
  }
  if (strcasecmp(action, "STOP") == 0) {
    return ACTION_STOP;
  }
  if (strcasecmp(action, "HVAC_SET_PARAMETERS") == 0
    || strcasecmp(action, "HVAC_SET_TEMPERATURE") == 0
    || strcasecmp(action, "HVAC_SET_TEMPERATURES") == 0) {
    return ACTION_HVAC_SET_PARAMETERS;
  }
  if (strcasecmp(action, "SET") == 0) {
    return ACTION_SET;
  }
  return 0;
}

static unsigned char parse_hvac_mode(const char *value) {
  if (value == NULL || value[0] == '\0') {
    return SUPLA_HVAC_MODE_NOT_SET;
  }

  if (strcasecmp(value, "OFF") == 0) {
    return SUPLA_HVAC_MODE_OFF;
  }
  if (strcasecmp(value, "HEAT") == 0) {
    return SUPLA_HVAC_MODE_HEAT;
  }
  if (strcasecmp(value, "COOL") == 0) {
    return SUPLA_HVAC_MODE_COOL;
  }
  if (strcasecmp(value, "HEAT_COOL") == 0) {
    return SUPLA_HVAC_MODE_HEAT_COOL;
  }
  if (strcasecmp(value, "FAN_ONLY") == 0) {
    return SUPLA_HVAC_MODE_FAN_ONLY;
  }
  if (strcasecmp(value, "DRY") == 0) {
    return SUPLA_HVAC_MODE_DRY;
  }
  if (strcasecmp(value, "TURN_ON") == 0) {
    return SUPLA_HVAC_MODE_CMD_TURN_ON;
  }
  if (strcasecmp(value, "WEEKLY_SCHEDULE") == 0) {
    return SUPLA_HVAC_MODE_CMD_WEEKLY_SCHEDULE;
  }
  if (strcasecmp(value, "SWITCH_TO_MANUAL") == 0) {
    return SUPLA_HVAC_MODE_CMD_SWITCH_TO_MANUAL;
  }

  return SUPLA_HVAC_MODE_NOT_SET;
}

static bool execute_action_command(
    BridgeContext *context,
    const char *request_id,
    const char *channel_id_text,
    const char *action_name,
    char *params_text) {
  int channel_id = 0;
  if (!parse_int_string(channel_id_text, &channel_id)) {
    emit_action_result(request_id, false, "Invalid channel id");
    return false;
  }

  const int action_id = map_action_name(action_name);
  if (action_id == 0) {
    emit_action_result(request_id, false, "Unsupported action");
    return false;
  }

  int percentage = -1;
  int tilt = VALUE_IGNORE;
  bool percentage_delta = false;
  bool tilt_delta = false;

  int brightness = -1;
  int color_brightness = -1;
  int color = 0;
  bool color_set = false;
  bool color_random = false;
  bool turn_on_off = false;
  int dimmer_cct = -1;

  int duration_sec = -1;
  unsigned char hvac_mode = SUPLA_HVAC_MODE_NOT_SET;
  int16_t setpoint_heat = 0;
  bool setpoint_heat_set = false;
  int16_t setpoint_cool = 0;
  bool setpoint_cool_set = false;

  int mask = -1;
  int active_bits = 0xFFFF;

  if (params_text != NULL) {
    char *save_ptr = NULL;
    char *token = strtok_r(params_text, "\t", &save_ptr);
    while (token != NULL) {
      char *separator = strchr(token, '=');
      if (separator != NULL) {
        *separator = '\0';
        const char *key = token;
        const char *value = separator + 1;

        if (strcasecmp(key, "percentage") == 0) {
          parse_int_string(value, &percentage);
        } else if (strcasecmp(key, "tilt") == 0) {
          parse_int_string(value, &tilt);
        } else if (strcasecmp(key, "percentageDelta") == 0) {
          percentage_delta = parse_bool_string(value, false);
        } else if (strcasecmp(key, "tiltDelta") == 0) {
          tilt_delta = parse_bool_string(value, false);
        } else if (strcasecmp(key, "brightness") == 0) {
          parse_int_string(value, &brightness);
        } else if (strcasecmp(key, "colorBrightness") == 0) {
          parse_int_string(value, &color_brightness);
        } else if (strcasecmp(key, "color") == 0) {
          if (parse_int_string(value, &color)) {
            color_set = true;
          }
        } else if (strcasecmp(key, "colorRandom") == 0) {
          color_random = parse_bool_string(value, false);
        } else if (strcasecmp(key, "turnOnOff") == 0) {
          turn_on_off = parse_bool_string(value, false);
        } else if (strcasecmp(key, "dimmerCct") == 0) {
          parse_int_string(value, &dimmer_cct);
        } else if (strcasecmp(key, "durationSec") == 0) {
          parse_int_string(value, &duration_sec);
        } else if (strcasecmp(key, "mode") == 0) {
          hvac_mode = parse_hvac_mode(value);
        } else if (strcasecmp(key, "temperatureHeat") == 0) {
          if (parse_float_to_hundredths(value, &setpoint_heat)) {
            setpoint_heat_set = true;
          }
        } else if (strcasecmp(key, "temperatureCool") == 0) {
          if (parse_float_to_hundredths(value, &setpoint_cool)) {
            setpoint_cool_set = true;
          }
        } else if (strcasecmp(key, "mask") == 0) {
          parse_int_string(value, &mask);
        } else if (strcasecmp(key, "activeBits") == 0) {
          parse_int_string(value, &active_bits);
        }
      }

      token = strtok_r(NULL, "\t", &save_ptr);
    }
  }

  bool ok = false;

  if (action_id == ACTION_SHUT_PARTIALLY || action_id == ACTION_REVEAL_PARTIALLY) {
    TAction_ShadingSystem_Parameters parameters;
    memset(&parameters, 0, sizeof(parameters));
    parameters.Percentage = (signed char)percentage;
    parameters.Tilt = (signed char)tilt;
    if (percentage_delta) {
      parameters.Flags |= SSP_FLAG_PERCENTAGE_AS_DELTA;
    }
    if (tilt_delta) {
      parameters.Flags |= SSP_FLAG_TILT_AS_DELTA;
    }

    ok = supla_client_execute_action(
      context->client,
      action_id,
      &parameters,
      (unsigned _supla_int16_t)sizeof(parameters),
      ACTION_SUBJECT_TYPE_CHANNEL,
      channel_id) > 0;
  } else if (action_id == ACTION_SET_RGBW_PARAMETERS) {
    TAction_RGBW_Parameters parameters;
    memset(&parameters, 0, sizeof(parameters));
    parameters.Brightness = (signed char)brightness;
    parameters.ColorBrightness = (signed char)color_brightness;
    parameters.Color = color_set ? (unsigned _supla_int_t)color : 0;
    parameters.ColorRandom = color_random ? 1 : 0;
    parameters.OnOff = turn_on_off ? 1 : 0;
    parameters.DimmerCct = (signed char)dimmer_cct;

    ok = supla_client_execute_action(
      context->client,
      action_id,
      &parameters,
      (unsigned _supla_int16_t)sizeof(parameters),
      ACTION_SUBJECT_TYPE_CHANNEL,
      channel_id) > 0;
  } else if (action_id == ACTION_HVAC_SET_PARAMETERS) {
    TAction_HVAC_Parameters parameters;
    memset(&parameters, 0, sizeof(parameters));

    if (duration_sec >= 0) {
      parameters.DurationSec = (unsigned _supla_int_t)duration_sec;
    }

    parameters.Mode = hvac_mode;
    if (setpoint_heat_set) {
      parameters.SetpointTemperatureHeat = setpoint_heat;
      parameters.Flags |= SUPLA_HVAC_VALUE_FLAG_SETPOINT_TEMP_HEAT_SET;
    }
    if (setpoint_cool_set) {
      parameters.SetpointTemperatureCool = setpoint_cool;
      parameters.Flags |= SUPLA_HVAC_VALUE_FLAG_SETPOINT_TEMP_COOL_SET;
    }

    ok = supla_client_execute_action(
      context->client,
      action_id,
      &parameters,
      (unsigned _supla_int16_t)sizeof(parameters),
      ACTION_SUBJECT_TYPE_CHANNEL,
      channel_id) > 0;
  } else if (action_id == ACTION_SET) {
    if (mask < 0) {
      emit_action_result(request_id, false, "SET action requires mask");
      return false;
    }

    ok = supla_client_set_dgf_transparency(
      context->client,
      channel_id,
      (unsigned short)mask,
      (unsigned short)active_bits) > 0;
  } else {
    ok = supla_client_execute_action(
      context->client,
      action_id,
      NULL,
      0,
      ACTION_SUBJECT_TYPE_CHANNEL,
      channel_id) > 0;
  }

  emit_action_result(request_id, ok, ok ? NULL : "Command rejected by native client");
  return ok;
}

static void process_command_line(BridgeContext *context, char *line) {
  if (line == NULL || line[0] == '\0') {
    return;
  }

  char *save_ptr = NULL;
  char *command = strtok_r(line, "\t", &save_ptr);
  if (command == NULL) {
    return;
  }

  if (strcasecmp(command, "SHUTDOWN") == 0) {
    context->shutdown_requested = true;
    return;
  }

  if (strcasecmp(command, "PING") == 0) {
    const char *request_id = strtok_r(NULL, "\t", &save_ptr);
    emit_action_result(request_id == NULL ? "" : request_id, true, "pong");
    return;
  }

  if (strcasecmp(command, "ACTION") == 0) {
    const char *request_id = strtok_r(NULL, "\t", &save_ptr);
    const char *channel_id = strtok_r(NULL, "\t", &save_ptr);
    const char *action_name = strtok_r(NULL, "\t", &save_ptr);

    if (request_id == NULL || channel_id == NULL || action_name == NULL) {
      emit_action_result(request_id == NULL ? "" : request_id, false, "Invalid ACTION command");
      return;
    }

    execute_action_command(context, request_id, channel_id, action_name, save_ptr);
    return;
  }

  emit_error_event("unsupported-command", command);
}

static void process_stdin(BridgeContext *context) {
  if (context->shutdown_requested) {
    return;
  }

  while (true) {
    ssize_t bytes_read = read(STDIN_FILENO,
                              context->input_buffer + context->input_buffer_size,
                              sizeof(context->input_buffer) - context->input_buffer_size - 1);

    if (bytes_read == 0) {
      context->shutdown_requested = true;
      return;
    }

    if (bytes_read < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
        break;
      }

      emit_error_event("stdin-read", strerror(errno));
      context->shutdown_requested = true;
      return;
    }

    context->input_buffer_size += (size_t)bytes_read;
    context->input_buffer[context->input_buffer_size] = '\0';

    char *line_start = context->input_buffer;
    while (true) {
      char *line_end = strchr(line_start, '\n');
      if (line_end == NULL) {
        break;
      }

      *line_end = '\0';
      if (line_end > line_start && line_end[-1] == '\r') {
        line_end[-1] = '\0';
      }

      process_command_line(context, line_start);
      line_start = line_end + 1;
    }

    if (line_start != context->input_buffer) {
      const size_t remaining = context->input_buffer + context->input_buffer_size - line_start;
      memmove(context->input_buffer, line_start, remaining);
      context->input_buffer_size = remaining;
      context->input_buffer[context->input_buffer_size] = '\0';
    }

    if (context->input_buffer_size >= sizeof(context->input_buffer) - 1) {
      emit_error_event("stdin-overflow", "Input line too long");
      context->input_buffer_size = 0;
      context->input_buffer[0] = '\0';
    }
  }
}

static bool parse_args(int argc, char **argv, BridgeConfig *config) {
  memset(config, 0, sizeof(BridgeConfig));
  config->port = 2016;
  config->ssl_enabled = true;
  config->protocol_version = SUPLA_PROTO_VERSION;
  config->connect_timeout_ms = DEFAULT_CONNECT_TIMEOUT_MS;
  config->reconnect_delay_ms = DEFAULT_RECONNECT_DELAY_MS;

  snprintf(config->name, sizeof(config->name), "%s", BRIDGE_NAME_DEFAULT);
  snprintf(config->soft_ver, sizeof(config->soft_ver), "%s", BRIDGE_SOFTVER_DEFAULT);

  for (int index = 1; index < argc; index++) {
    const char *argument = argv[index];

    if (strcmp(argument, "--host") == 0 && index + 1 < argc) {
      snprintf(config->host, sizeof(config->host), "%s", argv[++index]);
      continue;
    }

    if (strcmp(argument, "--port") == 0 && index + 1 < argc) {
      config->port = atoi(argv[++index]);
      continue;
    }

    if (strcmp(argument, "--ssl") == 0 && index + 1 < argc) {
      config->ssl_enabled = parse_bool_string(argv[++index], true);
      continue;
    }

    if (strcmp(argument, "--email") == 0 && index + 1 < argc) {
      snprintf(config->email, sizeof(config->email), "%s", argv[++index]);
      continue;
    }

    if (strcmp(argument, "--password") == 0 && index + 1 < argc) {
      snprintf(config->password, sizeof(config->password), "%s", argv[++index]);
      continue;
    }

    if (strcmp(argument, "--guid") == 0 && index + 1 < argc) {
      if (!parse_hex_bytes(argv[++index], config->guid, sizeof(config->guid))) {
        fprintf(stderr, "Invalid --guid value\n");
        return false;
      }
      continue;
    }

    if (strcmp(argument, "--auth-key") == 0 && index + 1 < argc) {
      if (!parse_hex_bytes(argv[++index], config->auth_key, sizeof(config->auth_key))) {
        fprintf(stderr, "Invalid --auth-key value\n");
        return false;
      }
      continue;
    }

    if (strcmp(argument, "--protocol-version") == 0 && index + 1 < argc) {
      const int parsed = atoi(argv[++index]);
      if (parsed > 0 && parsed <= 255) {
        config->protocol_version = (unsigned char)parsed;
      }
      continue;
    }

    if (strcmp(argument, "--name") == 0 && index + 1 < argc) {
      snprintf(config->name, sizeof(config->name), "%s", argv[++index]);
      continue;
    }

    if (strcmp(argument, "--soft-ver") == 0 && index + 1 < argc) {
      snprintf(config->soft_ver, sizeof(config->soft_ver), "%s", argv[++index]);
      continue;
    }

    if (strcmp(argument, "--connect-timeout-ms") == 0 && index + 1 < argc) {
      config->connect_timeout_ms = atoi(argv[++index]);
      continue;
    }

    if (strcmp(argument, "--reconnect-delay-ms") == 0 && index + 1 < argc) {
      config->reconnect_delay_ms = atoi(argv[++index]);
      continue;
    }

    fprintf(stderr, "Unknown argument: %s\n", argument);
    return false;
  }

  if (config->host[0] == '\0') {
    fprintf(stderr, "Missing required --host\n");
    return false;
  }

  if (config->email[0] == '\0') {
    fprintf(stderr, "Missing required --email\n");
    return false;
  }

  if (config->password[0] == '\0') {
    fprintf(stderr, "Missing required --password\n");
    return false;
  }

  if (config->port <= 0) {
    config->port = config->ssl_enabled ? 2016 : 2015;
  }

  if (config->connect_timeout_ms <= 0) {
    config->connect_timeout_ms = DEFAULT_CONNECT_TIMEOUT_MS;
  }

  if (config->reconnect_delay_ms <= 0) {
    config->reconnect_delay_ms = DEFAULT_RECONNECT_DELAY_MS;
  }

  return true;
}

static void on_connected(void *_client, void *user_data) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;
  context->registered = false;
  context->channels_eol_seen = false;
  emit_status_event("connected");
}

static void on_disconnected(void *_client, void *user_data) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;
  context->registered = false;
  context->channels_eol_seen = false;
  emit_status_event("disconnected");
}

static void on_registering(void *_client, void *user_data) {
  (void)_client;
  (void)user_data;
  emit_status_event("registering");
}

static void on_registered(void *_client, void *user_data, TSC_SuplaRegisterClientResult_D *result) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;
  context->registered = true;
  emit_registered_event(result);
  if (result->ChannelCount == 0) {
    context->channels_eol_seen = true;
    fputs("{\"type\":\"channels_eol\"}\n", stdout);
    fflush(stdout);
  }
}

static void on_register_error(void *_client, void *user_data, int code) {
  (void)_client;
  (void)user_data;
  char message[64];
  snprintf(message, sizeof(message), "register-error-%d", code);
  emit_error_event("register-error", message);
}

static void on_connection_error(void *_client, void *user_data, int code) {
  (void)_client;
  (void)user_data;
  char message[64];
  snprintf(message, sizeof(message), "connection-error-%d", code);
  emit_error_event("connection-error", message);
}

static void on_version_error(
    void *_client,
    void *user_data,
    int current_version,
    int remote_min_version,
    int remote_version) {
  (void)_client;
  (void)user_data;
  fprintf(stdout,
          "{\"type\":\"version_error\",\"currentVersion\":%d,\"remoteMinVersion\":%d,\"remoteVersion\":%d}\n",
          current_version,
          remote_min_version,
          remote_version);
  fflush(stdout);
}

static void on_channel_update(void *_client, void *user_data, TSC_SuplaChannel_E *channel) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;

  ChannelCacheEntry *entry = find_or_create_channel(&context->channels, channel->Id);
  if (entry != NULL) {
    entry->id = channel->Id;
    entry->device_id = channel->DeviceID;
    entry->location_id = channel->LocationID;
    entry->function_id = channel->Func;
    entry->type = channel->Type;
    entry->alt_icon = channel->AltIcon;
    entry->user_icon = channel->UserIcon;
    entry->flags = channel->Flags;
    entry->protocol_version = channel->ProtocolVersion;
    entry->online = channel->online;
    entry->sub_value_type = channel->value.sub_value_type;
    memcpy(entry->value, channel->value.value, SUPLA_CHANNELVALUE_SIZE);
    memcpy(entry->sub_value, channel->value.sub_value, SUPLA_CHANNELVALUE_SIZE);
    snprintf(entry->caption, sizeof(entry->caption), "%s", channel->Caption);
    entry->has_metadata = true;
    entry->has_value = true;
  }

  emit_channel_update_event(channel);

  if (channel->EOL == 1) {
    context->channels_eol_seen = true;
    fputs("{\"type\":\"channels_eol\"}\n", stdout);
    fflush(stdout);
  }
}

static void on_channel_value_update(void *_client, void *user_data, TSC_SuplaChannelValue_B *value) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;

  ChannelCacheEntry *entry = find_or_create_channel(&context->channels, value->Id);
  if (entry != NULL) {
    entry->online = value->online;
    entry->sub_value_type = value->value.sub_value_type;
    memcpy(entry->value, value->value.value, SUPLA_CHANNELVALUE_SIZE);
    memcpy(entry->sub_value, value->value.sub_value, SUPLA_CHANNELVALUE_SIZE);
    entry->has_value = true;
  }

  emit_channel_value_event(value);

  if (value->EOL == 1) {
    fputs("{\"type\":\"channel_values_eol\"}\n", stdout);
    fflush(stdout);
  }
}

static void on_channel_extended_value_update(
    void *_client,
    void *user_data,
    TSC_SuplaChannelExtendedValue *value) {
  (void)_client;
  (void)user_data;
  emit_channel_extended_value_event(value);
}

static void on_channel_relation_update(void *_client, void *user_data, TSC_SuplaChannelRelation *relation) {
  (void)_client;
  BridgeContext *context = (BridgeContext *)user_data;

  if ((relation->EOL & 0x2) != 0) {
    clear_relations(&context->relations);
  }

  upsert_relation(&context->relations, relation->Id, relation->ParentId, relation->Type);
  emit_channel_relation_event(relation);

  if ((relation->EOL & 0x1) != 0) {
    fputs("{\"type\":\"channel_relations_eol\"}\n", stdout);
    fflush(stdout);
  }
}

static void on_action_execution_result(
    void *_client,
    void *user_data,
    TSC_ActionExecutionResult *result) {
  (void)_client;
  (void)user_data;
  fprintf(stdout,
          "{\"type\":\"action_execution_result\",\"resultCode\":%u,\"actionId\":%d,\"subjectId\":%d,\"subjectType\":%d}\n",
          result->ResultCode,
          result->ActionId,
          result->SubjectId,
          result->SubjectType);
  fflush(stdout);
}

static bool init_client(BridgeContext *context) {
  TSuplaClientCfg cfg;
  supla_client_cfginit(&cfg);

  memcpy(cfg.clientGUID, context->config.guid, SUPLA_GUID_SIZE);
  memcpy(cfg.AuthKey, context->config.auth_key, SUPLA_AUTHKEY_SIZE);
  snprintf(cfg.Email, sizeof(cfg.Email), "%s", context->config.email);
  snprintf(cfg.Password, sizeof(cfg.Password), "%s", context->config.password);
  snprintf(cfg.Name, sizeof(cfg.Name), "%s", context->config.name);
  snprintf(cfg.SoftVer, sizeof(cfg.SoftVer), "%s", context->config.soft_ver);

  cfg.host = context->config.host;
  cfg.ssl_enabled = context->config.ssl_enabled ? 1 : 0;
  if (context->config.ssl_enabled) {
    cfg.ssl_port = context->config.port;
  } else {
    cfg.tcp_port = context->config.port;
  }
  cfg.protocol_version = context->config.protocol_version;
  cfg.user_data = context;

  cfg.cb_on_connected = on_connected;
  cfg.cb_on_disconnected = on_disconnected;
  cfg.cb_on_registering = on_registering;
  cfg.cb_on_registered = on_registered;
  cfg.cb_on_registererror = on_register_error;
  cfg.cb_on_connerror = on_connection_error;
  cfg.cb_on_versionerror = on_version_error;

  cfg.cb_channel_update = on_channel_update;
  cfg.cb_channel_value_update = on_channel_value_update;
  cfg.cb_channel_extendedvalue_update = on_channel_extended_value_update;
  cfg.cb_channel_relation_update = on_channel_relation_update;
  cfg.cb_on_action_execution_result = on_action_execution_result;

  context->client = supla_client_init(&cfg);
  if (context->client == NULL) {
    emit_error_event("init", "supla_client_init returned null");
    return false;
  }

  return true;
}

static void free_context(BridgeContext *context) {
  if (context->client != NULL) {
    supla_client_free(context->client);
    context->client = NULL;
  }

  free(context->channels.items);
  context->channels.items = NULL;
  context->channels.size = 0;
  context->channels.capacity = 0;

  free(context->relations.items);
  context->relations.items = NULL;
  context->relations.size = 0;
  context->relations.capacity = 0;
}

int main(int argc, char **argv) {
  BridgeContext context;
  memset(&context, 0, sizeof(context));

  if (!parse_args(argc, argv, &context.config)) {
    return 2;
  }

  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);

  if (fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) < 0) {
    emit_error_event("stdin", "Failed to enable non-blocking stdin");
  }

  setvbuf(stdout, NULL, _IOLBF, 0);
  supla_log_set_callback(log_callback);

  if (!init_client(&context)) {
    free_context(&context);
    return 3;
  }

  emit_status_event("initialized");

  while (!g_should_exit && !context.shutdown_requested) {
    process_stdin(&context);
    if (context.shutdown_requested) {
      break;
    }

    if (supla_client_connected(context.client) != 1) {
      emit_status_event("connecting");
      const char connected = supla_client_connect(context.client, context.config.connect_timeout_ms);
      if (connected != 1) {
        struct timespec delay;
        delay.tv_sec = context.config.reconnect_delay_ms / 1000;
        delay.tv_nsec = (context.config.reconnect_delay_ms % 1000) * 1000000L;
        nanosleep(&delay, NULL);
      }
      continue;
    }

    if (supla_client_iterate(context.client, 100000) != 1) {
      struct timespec delay;
      delay.tv_sec = context.config.reconnect_delay_ms / 1000;
      delay.tv_nsec = (context.config.reconnect_delay_ms % 1000) * 1000000L;
      nanosleep(&delay, NULL);
      continue;
    }
  }

  emit_status_event("stopping");
  free_context(&context);
  emit_status_event("stopped");
  return 0;
}
