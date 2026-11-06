// Shared example: an IMA-style flight computer with two ARINC 653
// partitions, a CAN bus, and enough timing, budget and deployment data for
// schedulability, resource budgets, bus load and code / ARINC 653 generation.

const TEXT = `package Flight_Computer
public
  with Base_Types, SEI, ARINC653, Data_Model;

  data Attitude
    properties
      Data_Model::Data_Representation => Struct;
      Data_Size => 24 Bytes;
  end Attitude;

  data Command
    properties
      Data_Model::Data_Representation => Struct;
      Data_Size => 8 Bytes;
  end Command;

  device IMU
    features
      att: out data port Attitude;
      can: requires bus access CAN_Bus;
    properties
      Dispatch_Protocol => Periodic;
      Period => 10 ms;
  end IMU;

  device Servo
    features
      cmd: in data port Command;
      can: requires bus access CAN_Bus;
  end Servo;

  thread Estimator
    features
      att_in: in data port Attitude;
      att_out: out data port Attitude;
    properties
      Dispatch_Protocol => Periodic;
      Period => 20 ms;
      Compute_Execution_Time => 2 ms .. 4 ms;
      SEI::MIPSBudget => 30.0 MIPS;
      SEI::RAMBudget => 2 MByte;
      Source_Language => (C);
      Compute_Entrypoint_Source_Text => "estimator_step";
  end Estimator;

  thread Logger
    features
      att_in: in data port Attitude;
    properties
      Dispatch_Protocol => Sporadic;
      Period => 100 ms;
      Compute_Execution_Time => 5 ms .. 10 ms;
      SEI::MIPSBudget => 10.0 MIPS;
      SEI::RAMBudget => 8 MByte;
  end Logger;

  thread Control_Law
    features
      att_in: in data port Attitude;
      cmd_out: out data port Command;
    properties
      Dispatch_Protocol => Periodic;
      Period => 10 ms;
      Compute_Execution_Time => 1 ms .. 3 ms;
      SEI::MIPSBudget => 50.0 MIPS;
      SEI::RAMBudget => 1 MByte;
      Source_Language => (C);
      Compute_Entrypoint_Source_Text => "control_law_step";
  end Control_Law;

  process Navigation
    features
      att_in: in data port Attitude;
      att_out: out data port Attitude;
  end Navigation;

  process implementation Navigation.impl
    subcomponents
      estimator: thread Estimator;
      logger: thread Logger;
    connections
      n1: port att_in -> estimator.att_in;
      n2: port estimator.att_out -> att_out;
      n3: port estimator.att_out -> logger.att_in;
  end Navigation.impl;

  process Flight_Control
    features
      att_in: in data port Attitude;
      cmd_out: out data port Command;
  end Flight_Control;

  process implementation Flight_Control.impl
    subcomponents
      law: thread Control_Law;
    connections
      f1: port att_in -> law.att_in;
      f2: port law.cmd_out -> cmd_out;
  end Flight_Control.impl;

  virtual processor Partition
  end Partition;

  processor Core
    features
      can: requires bus access CAN_Bus;
    properties
      SEI::MIPSCapacity => 120.0 MIPS;
      SEI::RAMCapacity => 16 MByte;
      Scheduling_Protocol => (RMS);
  end Core;

  processor implementation Core.ima
    subcomponents
      p_nav: virtual processor Partition { ARINC653::Partition_Identifier => 1; ARINC653::Partition_Name => "NAV"; ARINC653::Criticality => LEVEL_B; };
      p_ctl: virtual processor Partition { ARINC653::Partition_Identifier => 2; ARINC653::Partition_Name => "FCTL"; ARINC653::Criticality => LEVEL_A; };
    properties
      ARINC653::Module_Major_Frame => 20 ms;
      ARINC653::Module_Schedule => (
        [ Partition => reference (p_ctl); Duration => 8 ms; Periodic_Processing_Start => true; ],
        [ Partition => reference (p_nav); Duration => 12 ms; Periodic_Processing_Start => false; ]);
  end Core.ima;

  bus CAN_Bus
    properties
      SEI::BandWidthCapacity => 125.0 KBytesps;
  end CAN_Bus;

  system FCS
  end FCS;

  system implementation FCS.impl
    subcomponents
      imu: device IMU;
      servo: device Servo;
      nav: process Navigation.impl;
      fctl: process Flight_Control.impl;
      cpu: processor Core.ima;
      can: bus CAN_Bus;
    connections
      b1: bus access can -> imu.can;
      b2: bus access can -> servo.can;
      b3: bus access can -> cpu.can;
      c_imu: port imu.att -> nav.att_in;
      c_est: port nav.att_out -> fctl.att_in;
      c_cmd: port fctl.cmd_out -> servo.cmd;
    properties
      Actual_Processor_Binding => (reference (cpu.p_nav)) applies to nav;
      Actual_Processor_Binding => (reference (cpu.p_ctl)) applies to fctl;
      Actual_Connection_Binding => (reference (can)) applies to c_imu, c_cmd;
  end FCS.impl;
end Flight_Computer;
`;

export const FLIGHT_COMPUTER = {
  id: "flight-computer",
  name: "Flight computer (IMA / ARINC 653)",
  description: "Partitioned flight computer: schedulability, MIPS / RAM budgets, CAN bus load, code and ARINC 653 generation.",
  files: [{ name: "Flight_Computer.aadl", text: TEXT }],
  target: "Flight_Computer::FCS.impl",
};
