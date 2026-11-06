// Standard AADL property sets pre-loaded in every workspace (the equivalent of
// OSATE's plug-in contributions). They declare the commonly used properties of
// the AADL v2.2 predeclared sets, SEI, ARINC653, Data Model, EMV2 and the
// ARP4761 / MIL-STD-882 severity scales, so the validator and completion
// engine know their names, types, units and enumeration literals.

const AADL_PROJECT = `property set AADL_Project is
  Time_Units: type units (ps, ns => ps * 1000, us => ns * 1000, ms => us * 1000, sec => ms * 1000, min => sec * 60, hr => min * 60);
  Size_Units: type units (bits, Bytes => bits * 8, KByte => Bytes * 1000, MByte => KByte * 1000, GByte => MByte * 1000, TByte => GByte * 1000);
  Data_Rate_Units: type units (bitsps, Bytesps => bitsps * 8, KBytesps => Bytesps * 1000, MBytesps => KBytesps * 1000, GBytesps => MBytesps * 1000);
  Frequency_Units: type units (Hz, KHz => Hz * 1000, MHz => KHz * 1000, GHz => MHz * 1000);
  Processor_Speed_Units: type units (KIPS, MIPS => KIPS * 1000, GIPS => MIPS * 1000);
  Supported_Dispatch_Protocols: type enumeration (Periodic, Sporadic, Aperiodic, Timed, Hybrid, Background);
  Supported_Scheduling_Protocols: type enumeration (Rate_Monotonic_Protocol, Deadline_Monotonic_Protocol, EDF, RMS, DMS, Static, POSIX_1003_Highest_Priority_First_Protocol, Round_Robin_Protocol, ARINC653);
  Supported_Concurrency_Control_Protocols: type enumeration (None_Specified, Priority_Inheritance, Priority_Ceiling, Interrupt_Masking);
  Supported_Source_Languages: type enumeration (Ada95, Ada2005, Ada2012, C, Cpp, Java, Simulink, SCADE, Lustre);
  Supported_Queue_Processing_Protocols: type enumeration (FIFO);
  Supported_Connection_QoS: type enumeration (GuaranteedDelivery, OrderedDelivery, SecureDelivery);
  Max_Aadlinteger: constant aadlinteger => 2 ** 63;
  Max_Target_Integer: constant aadlinteger => 2 ** 31;
  Max_Base_Address: constant aadlinteger => 2 ** 32;
  Max_Memory_Size: constant Size => 2 ** 32 Bytes;
  Max_Queue_Size: constant aadlinteger => 512;
  Max_Thread_Limit: constant aadlinteger => 32;
  Max_Time: constant aadlinteger => 1000;
  Max_Urgency: constant aadlinteger => 12;
  Max_Word_Space: constant aadlinteger => 64;
  Max_Byte_Count: constant aadlinteger => 2 ** 32;
end AADL_Project;
`;

const TIMING = `property set Timing_Properties is
  Time: type aadlinteger 0 ps .. Max_Time units Time_Units;
  Time_Range: type range of Time;
  Access_Time: record (First: enumeration (Start, Completion); Last: enumeration (Start, Completion); Offset: Time_Range;) applies to (data access, bus access);
  Activate_Deadline: Time applies to (thread);
  Activate_Execution_Time: Time_Range applies to (thread);
  Compute_Deadline: Time applies to (thread, device, subprogram, event port, event data port);
  Compute_Execution_Time: Time_Range applies to (thread, device, subprogram, event port, event data port);
  Client_Subprogram_Execution_Time: Time applies to (subprogram);
  Clock_Jitter: Time applies to (processor, system);
  Clock_Period: Time applies to (processor, system);
  Clock_Period_Range: Time_Range applies to (processor, system);
  Deactivate_Deadline: Time applies to (thread);
  Deactivate_Execution_Time: Time_Range applies to (thread);
  Deadline: inherit Time => Period applies to (thread, thread group, process, system, device, virtual processor);
  Dispatch_Offset: Time applies to (thread, device);
  Execution_Time: Time applies to (thread, device, subprogram);
  First_Dispatch_Time: inherit Time applies to (thread, thread group);
  Frame_Period: Time applies to (system, processor, virtual processor);
  Input_Time: list of IO_Time_Spec applies to (port, data access);
  IO_Time_Spec: type record (Time: IO_Reference_Time; Offset: Time_Range;);
  IO_Reference_Time: type enumeration (Dispatch, Start, Completion, Deadline, NoIO);
  Latency: Time_Range applies to (flow, connection, port, bus, virtual bus, device, system, processor);
  Load_Deadline: Time applies to (process, system);
  Load_Time: Time_Range applies to (process, system);
  Output_Rate: Rate_Spec applies to (port, subprogram);
  Output_Time: list of IO_Time_Spec applies to (port, data access);
  Period: inherit Time applies to (thread, thread group, process, system, device, virtual processor, virtual bus, bus);
  Rate_Spec: type record (Value_Range: range of aadlreal; Rate_Unit: enumeration (PerSecond, PerDispatch); Rate_Distribution: Supported_Distributions;);
  Supported_Distributions: type enumeration (Fixed, Poisson);
  Reference_Time: Time applies to (thread, device);
  Slot_Time: Time applies to (processor, virtual processor);
  Startup_Deadline: Time applies to (processor, virtual processor, process, system);
  Startup_Execution_Time: Time_Range applies to (processor, virtual processor, process, system);
  Subprogram_Call_Rate: Rate_Spec applies to (subprogram);
  Timing: enumeration (Sampled, Immediate, Delayed) => Sampled applies to (port connection);
  Transmission_Time: record (Fixed: Time_Range; PerByte: Time_Range;) applies to (bus, virtual bus);
  Process_Swap_Execution_Time: Time_Range applies to (processor);
  Thread_Swap_Execution_Time: Time_Range applies to (processor, virtual processor);
  Scheduler_Quantum: Time applies to (processor, virtual processor);
end Timing_Properties;
`;

const THREAD = `property set Thread_Properties is
  Dispatch_Protocol: Supported_Dispatch_Protocols applies to (thread, device, virtual processor);
  Dispatch_Trigger: list of reference (port) applies to (thread, device);
  Dispatch_Able: aadlboolean applies to (thread);
  POSIX_Scheduling_Policy: enumeration (SCHED_FIFO, SCHED_RR, SCHED_OTHERS) applies to (thread, thread group);
  Priority: inherit aadlinteger applies to (thread, thread group, process, system, device, data);
  Priority_Map: list of Priority_Mapping applies to (processor);
  Priority_Mapping: type record (Aadl_Priority: aadlinteger; RTOS_Priority: aadlinteger;);
  Priority_Range: range of aadlinteger applies to (processor, virtual processor);
  Criticality: aadlinteger applies to (thread, thread group);
  Time_Slot: list of aadlinteger applies to (thread, thread group, process, system);
  Concurrency_Control_Protocol: Supported_Concurrency_Control_Protocols => None_Specified applies to (data);
  Urgency: aadlinteger 0 .. Max_Urgency applies to (port, subprogram);
  Dequeue_Protocol: enumeration (OneItem, MultipleItems, AllItems) => OneItem applies to (event port, event data port);
  Dequeued_Items: aadlinteger applies to (event port, event data port);
  Mode_Transition_Response: enumeration (emergency, planned) applies to (mode transition);
  Resumption_Policy: enumeration (restart, resume) applies to (thread, thread group, process, system);
  Active_Thread_Handling_Protocol: inherit Supported_Active_Thread_Handling_Protocols => abort applies to (thread, thread group, process, system);
  Supported_Active_Thread_Handling_Protocols: type enumeration (abort, complete_one_flush_queue, complete_one_transfer_queue, complete_one_preserve_queue, complete_all);
  Deactivation_Policy: enumeration (inactive, active) => inactive applies to (thread, thread group, process, system);
  Runtime_Protection: inherit aadlboolean applies to (process, system);
  Synchronized_Component: inherit aadlboolean => true applies to (thread, thread group, process, system);
end Thread_Properties;
`;

const DEPLOYMENT = `property set Deployment_Properties is
  Allowed_Processor_Binding_Class: inherit list of classifier (processor, virtual processor, system) applies to (thread, thread group, process, system, virtual processor, device);
  Allowed_Processor_Binding: inherit list of reference (processor, virtual processor, system) applies to (thread, thread group, process, system, virtual processor, device);
  Actual_Processor_Binding: inherit list of reference (processor, virtual processor, system) applies to (thread, thread group, process, system, virtual processor, device);
  Allowed_Memory_Binding_Class: inherit list of classifier (memory, system, processor) applies to (thread, thread group, process, system, device, data, data port, event data port, subprogram, processor);
  Allowed_Memory_Binding: inherit list of reference (memory, system, processor) applies to (thread, thread group, process, system, device, data, data port, event data port, subprogram, processor);
  Actual_Memory_Binding: inherit list of reference (memory) applies to (thread, thread group, process, system, processor, device, data, data port, event data port, feature group, data access, subprogram);
  Allowed_Connection_Binding_Class: inherit list of classifier (processor, virtual processor, bus, virtual bus, device, memory) applies to (feature, connection, thread, thread group, process, system, virtual bus);
  Allowed_Connection_Binding: inherit list of reference (processor, virtual processor, bus, virtual bus, device, memory) applies to (feature, connection, thread, thread group, process, system, virtual bus);
  Actual_Connection_Binding: inherit list of reference (processor, virtual processor, bus, virtual bus, device, memory) applies to (feature, connection, thread, thread group, process, system, virtual bus);
  Allowed_Subprogram_Call: list of reference (subprogram) applies to (subprogram access);
  Actual_Subprogram_Call: reference (subprogram) applies to (subprogram access);
  Allowed_Subprogram_Call_Binding: inherit list of reference (bus, processor, memory, device) applies to (subprogram, thread, thread group, process, system);
  Actual_Subprogram_Call_Binding: list of reference (bus, processor, memory, device) applies to (subprogram);
  Provided_Virtual_Bus_Class: inherit list of classifier (virtual bus) applies to (bus, virtual bus, processor, virtual processor, device, memory, system);
  Required_Virtual_Bus_Class: inherit list of classifier (virtual bus) applies to (virtual bus, connection, port, thread, thread group, process, system, device);
  Provided_Connection_Quality_Of_Service: inherit list of Supported_Connection_QoS applies to (bus, virtual bus, processor, virtual processor, system, device, memory);
  Required_Connection_Quality_Of_Service: inherit list of Supported_Connection_QoS applies to (port, connection, virtual bus, thread, thread group, process, system, device);
  Not_Collocated: record (Targets: list of reference (data, thread, process, system, connection); Location: classifier (processor, memory, bus, system);) applies to (data, thread, process, system, connection);
  Collocated: record (Targets: list of reference (data, thread, process, system, connection); Location: classifier (processor, memory, bus, system);) applies to (data, thread, process, system, connection);
  Allowed_Connection_Type: list of enumeration (Sampled_Data_Connection, Immediate_Data_Connection, Delayed_Data_Connection, Port_Connection, Data_Access_Connection, Subprogram_Access_Connection) applies to (bus, device);
  Allowed_Dispatch_Protocol: list of Supported_Dispatch_Protocols applies to (processor, virtual processor);
  Allowed_Period: list of Time_Range applies to (processor, system, virtual processor);
  Allowed_Physical_Access_Class: list of classifier (device, processor, memory, bus) applies to (bus);
  Allowed_Physical_Access: list of reference (device, processor, memory, bus) applies to (bus);
  Memory_Protocol: enumeration (execute_only, read_only, write_only, read_write) => read_write applies to (memory);
  Runtime_Protection_Support: aadlboolean applies to (processor, virtual processor);
  Scheduling_Protocol: inherit list of Supported_Scheduling_Protocols applies to (virtual processor, processor);
  Preemptive_Scheduler: aadlboolean applies to (processor, virtual processor);
  Thread_Limit: aadlinteger 0 .. Max_Thread_Limit => Max_Thread_Limit applies to (processor, virtual processor);
  Priority_Map_Range: range of aadlinteger applies to (processor);
end Deployment_Properties;
`;

const COMMUNICATION = `property set Communication_Properties is
  Fan_Out_Policy: enumeration (Broadcast, RoundRobin, Selective, OnDemand) applies to (port);
  Connection_Pattern: list of list of Supported_Connection_Patterns applies to (connection);
  Supported_Connection_Patterns: type enumeration (One_To_One, All_To_All, One_To_All, All_To_One, Next, Previous, Neighbors, All_Neighbors, Cyclic_Next, Cyclic_Previous);
  Connection_Set: list of Connection_Pair applies to (connection);
  Connection_Pair: type record (src: list of aadlinteger; dst: list of aadlinteger;);
  Overflow_Handling_Protocol: enumeration (DropOldest, DropNewest, Error) => DropOldest applies to (event port, event data port, subprogram access);
  Queue_Processing_Protocol: Supported_Queue_Processing_Protocols => FIFO applies to (event port, event data port, subprogram access);
  Queue_Size: aadlinteger 0 .. Max_Queue_Size => 1 applies to (event port, event data port, subprogram access);
  Required_Connection: aadlboolean => true applies to (feature);
  Timing: enumeration (Sampled, Immediate, Delayed) => Sampled applies to (port connection);
  Transmission_Type: enumeration (push, pull) applies to (port, port connection, bus, virtual bus);
  Input_Rate: Rate_Spec applies to (port);
  Subprogram_Call_Type: enumeration (Synchronous, SemiSynchronous) applies to (subprogram);
  Actual_Latency: Time_Range applies to (flow, connection, port);
  Transmission_Time: record (Fixed: Time_Range; PerByte: Time_Range;) applies to (bus, virtual bus);
  Data_Rate: aadlreal units Data_Rate_Units applies to (port, connection, bus, virtual bus);
  Bandwidth_Capacity: aadlreal units Data_Rate_Units applies to (bus, virtual bus);
end Communication_Properties;
`;

const MEMORY = `property set Memory_Properties is
  Size: type aadlinteger 0 Bytes .. Max_Memory_Size units Size_Units;
  Size_Range: type range of Size;
  Access_Right: Access_Rights => read_write applies to (data, data access, bus access, memory, bus, feature group);
  Access_Rights: type enumeration (read_only, write_only, read_write, by_method);
  Access_Time: Time_Range applies to (memory);
  Allowed_Message_Size: Size_Range applies to (bus, virtual bus);
  Assign_Time: record (Fixed: Time_Range; PerByte: Time_Range;) applies to (processor, memory);
  Base_Address: access aadlinteger 0 .. Max_Base_Address applies to (memory);
  Byte_Count: aadlinteger 0 .. Max_Byte_Count applies to (memory);
  Code_Size: Size applies to (data, thread, thread group, process, system, subprogram, processor, device);
  Data_Size: Size applies to (data, thread, thread group, process, system, subprogram, processor, device);
  Heap_Size: Size applies to (thread, subprogram);
  Memory_Size: Size applies to (memory, system);
  Read_Time: list of Time_Range applies to (memory);
  Source_Code_Size: Size applies to (data, thread, thread group, process, system, subprogram, device);
  Source_Data_Size: Size applies to (data, subprogram, thread, thread group, process, system, device);
  Source_Heap_Size: Size applies to (thread, subprogram);
  Source_Stack_Size: Size applies to (thread, subprogram);
  Stack_Size: Size applies to (thread, subprogram);
  Word_Size: Size => 8 bits applies to (memory);
  Word_Space: aadlinteger 1 .. Max_Word_Space => 1 applies to (memory);
  Write_Time: list of Time_Range applies to (memory);
end Memory_Properties;
`;

const PROGRAMMING = `property set Programming_Properties is
  Activate_Entrypoint: classifier (subprogram classifier) applies to (thread, device);
  Activate_Entrypoint_Source_Text: aadlstring applies to (thread, device);
  Compute_Entrypoint: classifier (subprogram classifier) applies to (thread, device, event port, event data port);
  Compute_Entrypoint_Source_Text: aadlstring applies to (thread, device, event port, event data port);
  Compute_Entrypoint_Call_Sequence: reference (subprogram call sequence) applies to (thread, device, event port, event data port);
  Deactivate_Entrypoint: classifier (subprogram classifier) applies to (thread, device);
  Deactivate_Entrypoint_Source_Text: aadlstring applies to (thread, device);
  Finalize_Entrypoint: classifier (subprogram classifier) applies to (thread, device);
  Finalize_Entrypoint_Source_Text: aadlstring applies to (thread, device);
  Initialize_Entrypoint: classifier (subprogram classifier) applies to (thread, device, process, system);
  Initialize_Entrypoint_Source_Text: aadlstring applies to (thread, device, process, system);
  Recover_Entrypoint: classifier (subprogram classifier) applies to (thread, device);
  Recover_Entrypoint_Source_Text: aadlstring applies to (thread, device);
  Source_Language: inherit list of Supported_Source_Languages applies to (subprogram, data, thread, thread group, process, system, bus, device, processor);
  Source_Name: aadlstring applies to (data, port, subprogram, parameter);
  Source_Text: inherit list of aadlstring applies to (data, port, subprogram, thread, thread group, process, system, memory, bus, device, processor, parameter);
  Supported_Source_Language: list of Supported_Source_Languages applies to (processor, virtual processor, system);
  Type_Source_Name: aadlstring applies to (data, port, parameter);
  Hardware_Description_Source_Text: inherit list of aadlstring applies to (memory, bus, device, processor, system);
  Hardware_Source_Language: Supported_Hardware_Source_Languages applies to (memory, bus, device, processor, system);
  Supported_Hardware_Source_Languages: type enumeration (VHDL);
  Device_Driver: classifier (abstract implementation) applies to (device);
end Programming_Properties;
`;

const MODELING = `property set Modeling_Properties is
  Acceptable_Array_Size: list of range of aadlinteger applies to (subcomponent);
  Classifier_Matching_Rule: enumeration (Classifier_Match, Equivalence, Subset, Conversion, Complement) applies to (connection, component implementation);
  Classifier_Substitution_Rule: enumeration (Classifier_Match, Type_Extension, Signature_Match) applies to (classifier, subcomponent);
  Implemented_As: classifier (system implementation, abstract implementation) applies to (memory, bus, virtual bus, device, virtual processor, processor, system);
  Prototype_Substitution_Rule: enumeration (Classifier_Match, Type_Extension, Signature_Match) applies to (prototype, classifier);
end Modeling_Properties;
`;

const SEI = `property set SEI is
  Weight_Units: type units (g, kg => g * 1000, t => kg * 1000);
  Weight: type aadlreal units SEI::Weight_Units;
  Power_Units: type units (mW, W => mW * 1000, KW => W * 1000);
  NetWeight: SEI::Weight applies to (all);
  GrossWeight: SEI::Weight applies to (all);
  WeightLimit: SEI::Weight applies to (all);
  PowerCapacity: aadlreal units SEI::Power_Units applies to (all);
  PowerBudget: aadlreal units SEI::Power_Units applies to (all);
  PowerSupply: aadlreal units SEI::Power_Units applies to (all);
  MIPSCapacity: aadlreal units Processor_Speed_Units applies to (processor, virtual processor, system);
  MIPSBudget: aadlreal units Processor_Speed_Units applies to (thread, thread group, process, system, device, virtual processor);
  RAMCapacity: Size applies to (memory, processor, system);
  RAMBudget: Size applies to (thread, thread group, process, system, data, subprogram, device);
  RAMActual: Size applies to (thread, thread group, process, system, data, subprogram, device);
  ROMCapacity: Size applies to (memory, processor, system);
  ROMBudget: Size applies to (thread, thread group, process, system, data, subprogram, device);
  ROMActual: Size applies to (thread, thread group, process, system, data, subprogram, device);
  BandWidthCapacity: aadlreal units Data_Rate_Units applies to (bus, virtual bus, connection);
  BandWidthBudget: aadlreal units Data_Rate_Units applies to (bus, virtual bus, connection, port);
  Data_Rate: aadlreal units Data_Rate_Units applies to (port, connection);
  Message_Rate: aadlreal applies to (port, connection);
  Processor_Speed: aadlreal units Processor_Speed_Units applies to (processor);
  Reference_Processor: classifier (processor) applies to (all);
  Platform: aadlstring applies to (processor, virtual processor, system);
  Is_Partition: aadlboolean applies to (process, virtual processor);
  Security_Level: aadlinteger applies to (all);
  Safety_Criticality: aadlinteger applies to (all);
  Priority: aadlinteger applies to (thread, process);
end SEI;
`;

const ARINC653 = `property set ARINC653 is
  Partition_Slots: list of Time applies to (processor, virtual processor);
  Slots_Allocation: list of reference (virtual processor) applies to (processor);
  Module_Major_Frame: Time applies to (processor);
  Module_Schedule: list of ARINC653::Schedule_Window applies to (processor);
  Schedule_Window: type record (Partition: reference (virtual processor); Duration: Time; Periodic_Processing_Start: aadlboolean;);
  Partition_Identifier: aadlinteger applies to (process, virtual processor);
  Partition_Name: aadlstring applies to (process, virtual processor);
  Criticality: ARINC653::Criticality_Type applies to (process, virtual processor);
  Criticality_Type: type enumeration (LEVEL_A, LEVEL_B, LEVEL_C, LEVEL_D, LEVEL_E);
  System_Partition: aadlboolean applies to (process, virtual processor);
  Timing: ARINC653::Timing_Type applies to (port connection);
  Timing_Type: type enumeration (Sampled, Queued);
  Sampling_Refresh_Period: list of Time applies to (data port);
  Supported_Error_Code: type enumeration (Module_Config, Module_Init, Module_Scheduling, Partition_Scheduling, Partition_Config, Partition_Handler, Partition_Init, Deadline_Miss, Application_Error, Numeric_Error, Illegal_Request, Stack_Overflow, Memory_Violation, Hardware_Fault, Power_Fail);
  Supported_Recovery_Action: type enumeration (Ignore, Confirm, Partition_Stop, Module_Stop, Process_Stop, Process_Restart, Partition_Restart, Module_Restart, Warm_Restart, Cold_Restart);
  HM_Error_ID_Levels: list of ARINC653::Error_ID_Level_Type applies to (processor, virtual processor, process, thread);
  Error_ID_Level_Type: type record (ErrorIdentifier: aadlinteger; Description: aadlstring; ErrorLevel: ARINC653::Error_Level_Type; ErrorCode: ARINC653::Supported_Error_Code;);
  Error_Level_Type: type enumeration (Module_Level, Partition_Level, Process_Level);
  HM_Error_ID_Actions: list of ARINC653::Error_ID_Action_Type applies to (processor, virtual processor, process, thread);
  Error_ID_Action_Type: type record (ErrorIdentifier: aadlinteger; Description: aadlstring; Action: aadlstring;);
  Memory_Type: list of ARINC653::Memory_Type_Kind applies to (memory);
  Memory_Type_Kind: type enumeration (Data_Memory, Code_Memory, IO_Memory);
  Access_Type: ARINC653::Access_Kind applies to (memory);
  Access_Kind: type enumeration (Read, Write, Read_Write);
  DAL: ARINC653::Criticality_Type applies to (process, virtual processor, thread);
end ARINC653;
`;

const DATA_MODEL = `property set Data_Model is
  Base_Type: list of classifier (data) applies to (data);
  Code_Set: aadlinteger applies to (data);
  Data_Digits: aadlinteger applies to (data);
  Data_Scale: aadlinteger applies to (data);
  Data_Representation: enumeration (Array, Boolean, Character, Enum, Float, Fixed, Integer, String, Struct, Union) applies to (data);
  Dimension: list of aadlinteger applies to (data);
  Element_Names: list of aadlstring applies to (data);
  Enumerators: list of aadlstring applies to (data);
  IEEE754_Precision: enumeration (Simple, Double) applies to (data);
  Infinite_Set: aadlboolean applies to (data);
  Initial_Value: list of aadlstring applies to (data, port, parameter);
  Integer_Range: range of aadlinteger applies to (data, port, parameter);
  Measurement_Unit: aadlstring applies to (data, port, parameter);
  Number_Representation: enumeration (Signed, Unsigned) applies to (data);
  Real_Range: range of aadlreal applies to (data, port, parameter);
  Representation: list of aadlstring applies to (data);
end Data_Model;
`;

const EMV2_PROPS = `property set EMV2 is
  OccurrenceDistribution: EMV2::DistributionSpecification applies to (all);
  DistributionSpecification: type record (ProbabilityValue: aadlreal; OccurrenceRate: aadlreal; MeanValue: aadlreal; StandardDeviation: aadlreal; Shape: aadlreal; Scale: aadlreal; Distribution: EMV2::DistributionFunction;);
  DistributionFunction: type enumeration (Fixed, Poisson, Exponential, Normal, Weibull, Binomial, Uniform);
  ExposurePeriod: Time applies to (all);
  Duration: Time_Range applies to (all);
  DetectionMechanism: aadlstring applies to (all);
  FaultKind: enumeration (Design, Operational) applies to (all);
  Persistence: enumeration (Permanent, Transient, Singleton) applies to (all);
  Description: aadlstring applies to (all);
  Hazards: list of record (CrossReference: aadlstring; HazardTitle: aadlstring; Description: aadlstring; Failure: aadlstring; FailureEffect: aadlstring; Phases: list of aadlstring; Environment: aadlstring; Mishap: aadlstring; FailureCondition: aadlstring; Risk: aadlstring; Severity: aadlinteger; Likelihood: aadlinteger; Comment: aadlstring;) applies to (all);
  Severity: aadlinteger applies to (all);
  Likelihood: aadlinteger applies to (all);
  Mitigation: aadlstring applies to (all);
end EMV2;
`;

const ARP4761 = `property set ARP4761 is
  Catastrophic: constant aadlinteger => 1;
  Hazardous: constant aadlinteger => 2;
  Major: constant aadlinteger => 3;
  Minor: constant aadlinteger => 4;
  NoEffect: constant aadlinteger => 5;
  Probable: constant aadlinteger => 1;
  Remote: constant aadlinteger => 2;
  ExtremelyRemote: constant aadlinteger => 3;
  ExtremelyImprobable: constant aadlinteger => 4;
  DevelopmentAssuranceLevel: enumeration (A, B, C, D, E) applies to (all);
end ARP4761;
`;

const MILSTD882 = `property set MILSTD882 is
  Catastrophic: constant aadlinteger => 1;
  Critical: constant aadlinteger => 2;
  Marginal: constant aadlinteger => 3;
  Negligible: constant aadlinteger => 4;
  Frequent: constant aadlinteger => 1;
  Probable: constant aadlinteger => 2;
  Occasional: constant aadlinteger => 3;
  Remote: constant aadlinteger => 4;
  Improbable: constant aadlinteger => 5;
end MILSTD882;
`;

/** Property sets whose properties may be used without a `Set::` prefix. */
export const PREDECLARED_SETS = [
  "AADL_Project", "Timing_Properties", "Thread_Properties", "Deployment_Properties", "Communication_Properties",
  "Memory_Properties", "Programming_Properties", "Modeling_Properties",
];

export const STANDARD_PROPERTY_SETS = [
  { name: "AADL_Project.aadl", text: AADL_PROJECT },
  { name: "Timing_Properties.aadl", text: TIMING },
  { name: "Thread_Properties.aadl", text: THREAD },
  { name: "Deployment_Properties.aadl", text: DEPLOYMENT },
  { name: "Communication_Properties.aadl", text: COMMUNICATION },
  { name: "Memory_Properties.aadl", text: MEMORY },
  { name: "Programming_Properties.aadl", text: PROGRAMMING },
  { name: "Modeling_Properties.aadl", text: MODELING },
  { name: "SEI.aadl", text: SEI },
  { name: "ARINC653.aadl", text: ARINC653 },
  { name: "Data_Model.aadl", text: DATA_MODEL },
  { name: "EMV2.aadl", text: EMV2_PROPS },
  { name: "ARP4761.aadl", text: ARP4761 },
  { name: "MILSTD882.aadl", text: MILSTD882 },
];
